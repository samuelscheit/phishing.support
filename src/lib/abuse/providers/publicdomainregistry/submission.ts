import { randomUUID } from "node:crypto";

import { asRecord } from "../../../util/values";
import type { BrowserFormField, BrowserFormResponse, BrowserFormSession } from "../browser_form";
import { createDraft, reportInputOf, type RouteDeps } from "../kit/draft";
import { evidenceReferenceOf, loadEvidenceFile } from "../kit/evidence";
import { formOpener, preparedState, withPreflight } from "../kit/session";
import { snippet } from "../../../util/text";
import {
	ProviderSubmissionNeedsHumanError,
	ProviderSubmissionRejectedError,
	type ProviderSubmissionContext,
	type ProviderSubmissionPreflight,
	type ProviderSubmissionSuccess,
} from "../submission_contracts";
import { PUBLIC_DOMAIN_REGISTRY_PROVIDER as PROVIDER } from "./definition";
import {
	buildPublicDomainRegistrySubmissionPayload,
	PUBLIC_DOMAIN_REGISTRY_EVIDENCE_CONTRACT,
	storedPublicDomainRegistrySubmissionPayload,
	type PublicDomainRegistrySubmissionPayload,
} from "./payload";

export type PublicDomainRegistryDependencies = RouteDeps & {
	/** The browser on the form with the challenge passed; tests inject a fake. */
	openForm?: (signal: AbortSignal | undefined) => Promise<BrowserFormSession>;
	getArtifact?: Parameters<typeof loadEvidenceFile>[0]["getArtifact"];
};

/** What the preflight leaves for the one request after the marker. */
export type PublicDomainRegistryPreflightState = {
	session: BrowserFormSession;
	token: string;
	/** The form's own hidden and anti-spam fields, as the page rendered them. */
	rendered: BrowserFormField[];
	/** `<folder>/<file>` of each uploaded attachment. */
	uploads: string[];
};

export const publicDomainRegistryDraft = createDraft({
	definition: PROVIDER,
	reasonPrefix: "publicdomainregistry",
	targetTypes: ["domain"],
	targetReason: "publicdomainregistry_requires_a_domain_target",
	read: storedPublicDomainRegistrySubmissionPayload,
	input: (data, stored?: PublicDomainRegistrySubmissionPayload) => ({ ...reportInputOf(data), evidence: evidenceReferenceOf(PUBLIC_DOMAIN_REGISTRY_EVIDENCE_CONTRACT, data.evidenceArtifacts, stored) }),
	build: buildPublicDomainRegistrySubmissionPayload,
	targetOf: (payload) => payload.target.domain,
});

/** Check the route and build the durable draft before any provider call. */
export const preparePublicDomainRegistrySubmission = publicDomainRegistryDraft.prepare;

/** The uploader's `{success, data: {path, file}}`: the path the feedback names the file by. */
export function uploadedPath(answer: BrowserFormResponse): string {
	const json = asRecord(answer.json);
	const data = asRecord(json?.data);
	if (answer.status !== 200 || json?.success !== true || typeof data?.path !== "string" || typeof data.file !== "string" || !data.path || !data.file || /[\s\\]|\.\./.test(`${data.path}${data.file}`)) {
		throw new Error(`PublicDomainRegistry's upload was not accepted (HTTP ${answer.status}): ${snippet(answer.text)}`);
	}
	return `${data.path}/${data.file}`;
}

/** The uploader's own request for one file, as the page's drag-and-drop widget makes it. */
function uploadFields(nonce: string, file: { filename: string; mimeType: string; base64: string }, ids: { folder: string; token: string }): BrowserFormField[] {
	return [
		["action", "dnd_codedropz_upload"],
		["type", "click"],
		["security", nonce],
		["hp_field", ""],
		["form_id", PROVIDER.formId],
		["upload_name", PROVIDER.fields.upload.replace("[]", "")],
		["upload_folder", ids.folder],
		["token", ids.token],
		["upload-file", file],
	];
}

/**
 * Before the marker: open the form past Cloudflare's challenge, upload the
 * screenshot, wait for the Turnstile token and read the page's own hidden and
 * anti-spam fields. None of it files a report, so every failure is a safe
 * retry (the browser is closed first).
 */
export async function preparePublicDomainRegistryExternalSubmission(context: ProviderSubmissionContext, dependencies: PublicDomainRegistryDependencies = {}): Promise<ProviderSubmissionPreflight> {
	const { payload, data } = await publicDomainRegistryDraft.verify(context, dependencies);
	const file = payload.evidence
		? (await loadEvidenceFile({ reference: payload.evidence, contract: PUBLIC_DOMAIN_REGISTRY_EVIDENCE_CONTRACT, reportId: data.report.id, label: "PublicDomainRegistry", ...(dependencies.getArtifact ? { getArtifact: dependencies.getArtifact } : {}) })).file
		: undefined;
	return withPreflight(() => (dependencies.openForm ?? formOpener(PROVIDER, "publicdomainregistry-report", { url: PROVIDER.formUrl, formSelector: PROVIDER.formSelector }))(context.signal), async (session): Promise<PublicDomainRegistryPreflightState> => {
		const uploads: string[] = [];
		if (file) {
			const nonce = await session.readGlobal(PROVIDER.uploadNonceGlobal);
			if (typeof nonce !== "string" || !nonce) throw new Error("PublicDomainRegistry's page carries no upload nonce.");
			uploads.push(uploadedPath(await session.postForm(PROVIDER.uploadUrl, uploadFields(nonce, file, { folder: randomUUID(), token: randomUUID() }), PROVIDER.timeoutMs)));
		}
		// Last, so the token (valid for minutes) and Akismet's behaviour fields are fresh.
		const token = await session.waitForTurnstileToken();
		const rendered = await session.readFormFields(PROVIDER.renderedFieldPattern);
		const missing = PROVIDER.requiredRenderedFields.filter((name) => !rendered.some(([field, value]) => field === name && typeof value === "string" && value !== ""));
		if (missing.length > 0) throw new Error(`PublicDomainRegistry's form no longer renders ${missing.join(", ")}.`);
		if (rendered.find(([name]) => name === "_wpcf7")?.[1] !== PROVIDER.formId) throw new Error("PublicDomainRegistry's phishing form is no longer Contact Form 7 form 643.");
		return { session, token, rendered, uploads };
	});
}

/** The feedback request's parts: the page's fields first, then the form's inputs. */
export function feedbackFields(payload: PublicDomainRegistrySubmissionPayload, state: Pick<PublicDomainRegistryPreflightState, "rendered" | "token" | "uploads">): BrowserFormField[] {
	return [
		...state.rendered,
		[PROVIDER.fields.name, PROVIDER.reporter.name],
		[PROVIDER.fields.domain, payload.target.domain],
		[PROVIDER.fields.complaint, payload.report.complaint],
		[PROVIDER.fields.email, PROVIDER.reporter.email],
		...state.uploads.map((path): BrowserFormField => [PROVIDER.fields.upload, path]),
		[PROVIDER.fields.consent, PROVIDER.consent],
		[PROVIDER.fields.turnstile, state.token],
	];
}

/**
 * Contact Form 7 statuses that prove no mail was sent and nothing filed: the
 * form was refused before its mail step. `mail_failed` and anything unknown
 * leave it open whether the site kept the report anyway.
 */
const NOTHING_FILED = new Set(["validation_failed", "aborted", "acceptance_missing", "init_failed"]);

/** The one irreversible request: Contact Form 7's feedback with the pinned draft and the preflight's page state. */
export async function submitPublicDomainRegistrySubmission(context: ProviderSubmissionContext, preflight: ProviderSubmissionPreflight | undefined): Promise<ProviderSubmissionSuccess> {
	const payload = storedPublicDomainRegistrySubmissionPayload(context.payload);
	if (!payload) throw new Error("The persisted PublicDomainRegistry submission payload is malformed.");
	const state = preparedState<PublicDomainRegistryPreflightState>(
		preflight,
		(prepared) => !!prepared.session && typeof prepared.token === "string" && !!prepared.token && Array.isArray(prepared.rendered) && Array.isArray(prepared.uploads),
		"PublicDomainRegistry submission requires its prepared browser session and Turnstile token.",
	);
	const answer = await state.session.postForm(PROVIDER.feedbackUrl, feedbackFields(payload, state), PROVIDER.timeoutMs);
	const json = asRecord(answer.json);
	const status = typeof json?.status === "string" ? json.status : undefined;
	const message = typeof json?.message === "string" ? snippet(json.message) : "";
	if (status === "mail_sent") {
		return {
			confirmationId: payload.report.trackingId,
			confirmationText: `PublicDomainRegistry accepted the report${message ? `: ${message}` : ""}`,
			finalUrl: PROVIDER.formUrl,
			submittedTargets: [payload.target.domain],
		};
	}
	// Akismet judged our session, not the report: nothing was filed, and a person
	// should look (and file it by hand) rather than the route ending as refused.
	if (status === "spam") throw new ProviderSubmissionNeedsHumanError(`PublicDomainRegistry's spam filter (Akismet) held the report back${message ? `: ${message}` : ""}`);
	if (status && NOTHING_FILED.has(status)) {
		const invalid = Array.isArray(json?.invalid_fields)
			? json.invalid_fields.map((field) => asRecord(field)?.field).filter((field): field is string => typeof field === "string")
			: [];
		throw new ProviderSubmissionRejectedError(`PublicDomainRegistry refused the report (${status}${invalid.length ? `: ${invalid.join(", ")}` : ""})${message ? `: ${message}` : ""}`);
	}
	throw new Error(`PublicDomainRegistry answered the report with HTTP ${answer.status}${status ? ` and status ${status}` : ""}: ${snippet(answer.text)}`);
}
