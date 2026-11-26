import { createHash } from "node:crypto";

import { kitFingerprints, type KitCapture, type KitFingerprint, type KitFingerprintKind } from "../abuse/origin/siblings";
import { CampaignRepository } from "../campaign/repository";
import { SubmissionsEntity } from "../db/entities/submissions";
import { readResponseBody } from "../network/bounded_fetch";
import { fetchThroughPublicRedirects } from "../network/public_redirects";
import { browserRequestHeaders } from "../network/service_identity";
import type { SiteCheckDependencies } from "./check";

const FILE_TIMEOUT_MS = 15_000;
/** Kit files are scripts and frame documents; one larger than this is not one the capture kept. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** Captured files compared per check: each is one request to the site. */
const MAX_PROOF_FILES = 5;

/**
 * Files any site may serve: public libraries and frameworks, CMS cores, the
 * scripts of analytics, consent and captcha services. Serving one proves
 * nothing about which site it is.
 */
const LIBRARY_PATH = /(?:^|[/._-])(?:jquery|bootstrap|popper|lodash|underscore|react(?:-dom)?|vue|angular|moment|axios|modernizr|polyfills?|core-js|swiper|slick|owl\.carousel|select2|gsap|three|chart|d3|font-?awesome|fontawesome|aos|wow|lazysizes|recaptcha|hcaptcha|turnstile|gtag|analytics|gtm|fbevents|cookieconsent|wp-emoji|wp-embed)(?:[/._-]|$)|\/(?:wp-includes|wp-content\/plugins|node_modules|vendor|libs?|cdn-cgi)\//i;

/** A captured file of the reported host that only its own kit serves, to be fetched from wherever the site is now. */
export type KitProofFile = { path: string; sha256: string; kind: KitFingerprintKind };

export type IsSharedKitFile = (sha256: string, reportId: bigint) => Promise<boolean>;

/**
 * The captured files only the reported site's kit has: its scripts and
 * hidden frames from any host, never a stylesheet (templates share them), a
 * library by its name or path, or a file many unrelated sites serve
 * (`isSharedKitFile`).
 */
export async function distinctiveKitFiles(capture: KitCapture, reportId: bigint, isShared: IsSharedKitFile = CampaignRepository.isSharedKitFile): Promise<KitFingerprint[]> {
	const files: KitFingerprint[] = [];
	for (const fingerprint of kitFingerprints(capture)) {
		if (fingerprint.kind === "stylesheet" || LIBRARY_PATH.test(new URL(fingerprint.url).pathname)) continue;
		if (!(await isShared(fingerprint.sha256, reportId))) files.push(fingerprint);
	}
	return files;
}

/** The kit files of `host`, as paths to request from wherever it is hosted now. */
export function proofFilesOn(files: readonly KitFingerprint[], host: string): KitProofFile[] {
	return files
		.map((file) => ({ url: new URL(file.url), file }))
		.filter(({ url }) => url.hostname === host)
		.slice(0, MAX_PROOF_FILES)
		.map(({ url, file }) => ({ path: `${url.pathname}${url.search}`, sha256: file.sha256, kind: file.kind }));
}

/** The distinctive kit files the case captured on the reported host, as paths to request from it. */
export async function kitProofFiles(params: { submissionId: bigint | null; host: string; reportId: bigint }, isShared?: IsSharedKitFile): Promise<KitProofFile[]> {
	if (params.submissionId === null) return [];
	const submission = await SubmissionsEntity.get(params.submissionId);
	if (submission?.data.kind !== "website") return [];
	return proofFilesOn(await distinctiveKitFiles(submission.data.website, params.reportId, isShared), params.host);
}

/** The proof files the site's current hosting serves byte for byte, requested as the capture's browser did. */
export async function servedKitFiles(url: string, files: readonly KitProofFile[], dependencies: SiteCheckDependencies): Promise<Array<{ url: string; sha256: string }>> {
	const origin = new URL(url).origin;
	const served: Array<{ url: string; sha256: string }> = [];
	for (const file of files) {
		const fileUrl = `${origin}${file.path}`;
		try {
			const { response } = await fetchThroughPublicRedirects(fileUrl, {
				...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
				...(dependencies.assertPublicHost ? { assertPublicHost: dependencies.assertPublicHost } : {}),
				...(dependencies.signal ? { signal: dependencies.signal } : {}),
				subject: "reported site",
				headers: { ...browserRequestHeaders },
				maxRedirects: 0,
				timeoutMs: FILE_TIMEOUT_MS,
			});
			if (response.status !== 200) {
				await response.body?.cancel().catch(() => undefined);
				continue;
			}
			const sha256 = createHash("sha256").update(await readResponseBody(response, MAX_FILE_BYTES)).digest("hex");
			if (sha256 === file.sha256) served.push({ url: fileUrl, sha256 });
		} catch {
			if (dependencies.signal?.aborted) throw dependencies.signal.reason;
		}
	}
	return served;
}
