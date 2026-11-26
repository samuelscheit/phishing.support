import { simpleParser } from "mailparser";

import { ArtifactsEntity } from "../../db/entities/artifacts";
import { SubmissionsEntity } from "../../db/entities/submissions";
import { sha256Hex } from "../../util/hash";
import { kitFingerprints } from "./siblings";
import type { OriginVerificationTarget } from "./sweep";

/** Each target is one request per checked address, so a few exact files are enough. */
const MAX_VERIFICATION_TARGETS = 5;

/**
 * Files of the reported host whose exact bytes the case captured: a server
 * that returns them serves the reported site. Only the reported host's own
 * files count, since only they can be requested from wherever it moves.
 */
export async function originVerificationTargets(submissionId: bigint | null, domain: string): Promise<OriginVerificationTarget[]> {
	if (!submissionId) return [];
	const submission = await SubmissionsEntity.get(submissionId);
	const liveTargets = kitFingerprints(submission?.data.kind === "website" ? submission.data.website : {})
		.map(({ url, sha256 }) => ({ url: new URL(url), sha256 }))
		.filter(({ url }) => url.hostname === domain)
		.slice(0, MAX_VERIFICATION_TARGETS)
		.map(({ url, sha256 }) => ({ path: `${url.pathname}${url.search}`, sha256 }));
	if (liveTargets.length) return liveTargets;

	// Uploaded and inherited captures have no live response recorder. Chromium's
	// MHTML still retains same-host stylesheets as decoded MIME parts, which are
	// safe exact-byte verification targets (scripts are deliberately not guessed).
	// Every page the capture reached on the site contributes its stylesheets.
	const artifacts = await ArtifactsEntity.listForSubmission(submissionId);
	const targets = new Map<string, OriginVerificationTarget>();
	for (const reference of artifacts.filter(({ kind }) => kind === "website_mhtml")) {
		const mhtml = await ArtifactsEntity.get(reference.id);
		if (!mhtml?.blob) continue;
		const parsed = await simpleParser(mhtml.blob);
		for (const attachment of parsed.attachments) {
			if (attachment.contentType !== "text/css" || attachment.content.byteLength < 1_024) continue;
			const location = attachment.headers.get("content-location");
			if (typeof location !== "string") continue;
			let url: URL;
			try {
				url = new URL(location);
			} catch {
				continue;
			}
			if (url.hostname !== domain) continue;
			const path = `${url.pathname}${url.search}`;
			targets.set(path, { path, sha256: sha256Hex(attachment.content) });
			if (targets.size >= MAX_VERIFICATION_TARGETS) return [...targets.values()];
		}
	}
	return [...targets.values()];
}
