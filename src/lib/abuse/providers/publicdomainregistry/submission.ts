import { randomUUID } from "node:crypto";

import { asRecord } from "../../../values";
import { abuseEmailCaseUrl, hostingAddressLine } from "../../mail/draft";
import { AbuseRepository } from "../../repository";
import { routeContext } from "../../worker/shared";
import { openBrowserForm, type BrowserFormField, type BrowserFormResponse, type BrowserFormSession } from "../browser_form";
import { providerDefinitionMatchesPin } from "../definition";
import { providerEvidenceImageArtifactMatches } from "../evidence_image";
import { reportReference } from "../report_reference";
import {
	ProviderSubmissionNeedsHumanError,
	ProviderSubmissionRejectedError,
	type ProviderSubmissionContext,
	type ProviderSubmissionPreflight,
	type ProviderSubmissionPreparation,
	type ProviderSubmissionSuccess,
} from "../submission_contracts";
import { PUBLIC_DOMAIN_REGISTRY_PROVIDER as PROVIDER } from "./definition";
import {
	buildPublicDomainRegistrySubmissionPayload,
	PUBLIC_DOMAIN_REGISTRY_EVIDENCE_CONTRACT,
	selectPublicDomainRegistryEvidenceArtifact,
	storedPublicDomainRegistrySubmissionPayload,
	type PublicDomainRegistryReportInput,
	type PublicDomainRegistrySubmissionPayload,
} from "./payload";

export type PublicDomainRegistryDependencies = {
	/** The browser on the form with the challenge passed; tests inject a fake. */
	openForm?: (signal: AbortSignal | undefined) => Promise<BrowserFormSession>;
	loadRouteContext?: typeof routeContext;
	getArtifact?: typeof AbuseRepository.getArtifact;
};

type Context = Awaited<ReturnType<typeof routeContext>>;

/** What the preflight leaves for the one request after the marker. */
export type PublicDomainRegistryPreflightState = {
	session: BrowserFormSession;
	token: string;
	/** The form's own hidden and anti-spam fields, as the page rendered them. */
	rendered: BrowserFormField[];
	/** `<folder>/<file>` of each uploaded attachment. */
	uploads: string[];
};

function reportInput({ route, report, target }: Context): PublicDomainRegistryReportInput {
	const hostingLine = hostingAddressLine(route);
	const caseUrl = abuseEmailCaseUrl(report.submissionId);
	return {
		target: target.normalizedTarget,
		observedUrls: target.observedUrls,
		description: report.description,
		allegationCategory: report.allegationCategory,
		legalBrandUrl: report.legalBrandUrl,
		trackingId: reportReference(report.id, route.id),
		...(caseUrl ? { caseUrl } : {}),
		...(hostingLine ? { hostingLine } : {}),
	};
}

function routeIsOurs(route: Context["route"]): boolean {
	return route.routeType === "provider_submission" && route.providerRegistryKey === PROVIDER.key
		&& providerDefinitionMatchesPin(PROVIDER, route.providerDefinitionVersion, route.providerDefinitionHash);
}

/** Check the route and build the durable draft before any provider call. */
export async function preparePublicDomainRegistrySubmission(context: ProviderSubmissionContext, dependencies: PublicDomainRegistryDependencies = {}): Promise<ProviderSubmissionPreparation> {
	const routeData = await (dependencies.loadRouteContext ?? routeContext)(context.routeId);
	if (!routeIsOurs(routeData.route)) return { outcome: "insufficient_evidence", reason: "publicdomainregistry_provider_definition_pin_mismatch" };
	if (routeData.target.targetType !== "domain") return { outcome: "insufficient_evidence", reason: "publicdomainregistry_requires_a_domain_target" };
	const payload = buildPublicDomainRegistrySubmissionPayload({ ...reportInput(routeData), evidence: selectPublicDomainRegistryEvidenceArtifact(routeData.evidenceArtifacts) ?? null });
	return payload ? { outcome: "ready", payload } : { outcome: "insufficient_evidence", reason: "publicdomainregistry_report_payload_invalid" };
}

/** The stored draft, checked against its route and rebuilt from the current report around its stored screenshot. */
export async function verifiedPublicDomainRegistryDraft(context: ProviderSubmissionContext, dependencies: PublicDomainRegistryDependencies = {}): Promise<{ payload: PublicDomainRegistrySubmissionPayload; routeData: Context }> {
	const payload = storedPublicDomainRegistrySubmissionPayload(context.payload);
	if (!payload) throw new Error("The persisted PublicDomainRegistry submission payload is malformed.");
	const routeData = await (dependencies.loadRouteContext ?? routeContext)(context.routeId);
	if (!routeIsOurs(routeData.route) || routeData.target.normalizedTarget !== payload.target.domain) {
		throw new Error("The persisted PublicDomainRegistry payload no longer matches its route.");
	}
	const expected = buildPublicDomainRegistrySubmissionPayload({ ...reportInput(routeData), evidence: payload.evidence });
	if (!expected || JSON.stringify(expected) !== JSON.stringify(payload)) throw new Error("The persisted PublicDomainRegistry payload no longer matches the report evidence.");
	return { payload, routeData };
}

function snippet(body: string): string {
	return body.replace(/\s+/g, " ").trim().slice(0, 300);
}

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
	const { payload, routeData } = await verifiedPublicDomainRegistryDraft(context, dependencies);
	let file: { filename: string; mimeType: string; base64: string } | undefined;
	if (payload.evidence) {
		const artifact = await (dependencies.getArtifact ?? AbuseRepository.getArtifact)(routeData.report.id, BigInt(payload.evidence.artifactId));
		if (!artifact || !providerEvidenceImageArtifactMatches(payload.evidence, artifact, PUBLIC_DOMAIN_REGISTRY_EVIDENCE_CONTRACT)) {
			throw new Error("The persisted PublicDomainRegistry evidence artifact no longer matches its immutable reference.");
		}
		file = { filename: payload.evidence.filename, mimeType: payload.evidence.mimeType, base64: Buffer.from(artifact.blob).toString("base64") };
	}
	const session = await (dependencies.openForm ?? ((signal) => openBrowserForm({
		provider: PROVIDER.displayName,
		operation: "publicdomainregistry-report",
		url: PROVIDER.formUrl,
		formSelector: PROVIDER.formSelector,
		...(signal ? { signal } : {}),
	})))(context.signal);
	try {
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
		const state: PublicDomainRegistryPreflightState = { session, token, rendered, uploads };
		return { state, dispose: () => session.close() };
	} catch (error) {
		await session.close();
		throw error;
	}
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
	const state = preflight?.state as PublicDomainRegistryPreflightState | undefined;
	if (!state?.session || typeof state.token !== "string" || !state.token || !Array.isArray(state.rendered) || !Array.isArray(state.uploads)) {
		throw new Error("PublicDomainRegistry submission requires its prepared browser session and Turnstile token.");
	}
	const answer = await state.session.postForm(PROVIDER.feedbackUrl, feedbackFields(payload, state), PROVIDER.timeoutMs);
	const json = asRecord(answer.json);
	const status = typeof json?.status === "string" ? json.status : undefined;
	const message = typeof json?.message === "string" ? json.message.replace(/\s+/g, " ").trim().slice(0, 300) : "";
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
