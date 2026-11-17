import { createHash } from "node:crypto";

import { matchedCanaries } from "../exfiltration/analysis";
import type { CapturedNetworkRequest, ExfiltrationBackend, ExfiltrationCanaries } from "../exfiltration/types";
import type { VisitAgentAction } from "../site_visit/agent";
import { canonicalJson } from "./package";
import { timestampEvidence, type EvidenceTimestamp } from "./timestamp";
import type { EvidenceFile } from "./package";

/**
 * The record of one visit through a phishing site, kept so it can be used
 * in a criminal case: which synthetic values were generated, how each was
 * entered (what the agent typed into which field, and when), which pages
 * were shown, and every request that left the browser carrying one of the
 * values, with its full body, the page that sent it and the server's answer.
 *
 * Three files and a timestamp token: `visit-record.json` (complete,
 * machine-readable), `visit-protocol.txt` (the same as a dated chronology
 * for a reader), `visit-manifest.json` naming both by SHA-256, and
 * `visit-manifest.tsr`, an RFC 3161 token from an independent authority over
 * the manifest. Any later change to a file breaks its hash; the token
 * proves the manifest existed at the authority's time.
 */
export const VISIT_EVIDENCE_FILES = {
	record: "visit-record.json",
	protocol: "visit-protocol.txt",
	manifest: "visit-manifest.json",
	timestamp: "visit-manifest.tsr",
} as const;

export type VisitEvidenceFacts = {
	caseId: string;
	submittedUrl: string;
	startedAt: Date;
	endedAt: Date;
	environment: { device: string; egress?: string; agent: string; agentOutcome: string };
	syntheticValues: ExfiltrationCanaries;
	actions: readonly VisitAgentAction[];
	pages: ReadonlyArray<{ url: string; shownFrom: Date; shownUntil?: Date }>;
	requests: readonly CapturedNetworkRequest[];
	backends: readonly ExfiltrationBackend[];
};

export type VisitEvidence = { files: EvidenceFile[]; timestamp?: EvidenceTimestamp };

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const FIELD_NAMES: Record<keyof ExfiltrationCanaries, string> = {
	marker: "marker",
	email: "email address",
	password: "password",
	phone: "phone number",
	cardNumber: "card number",
	oneTimeCode: "one-time code",
};

/** Which synthetic values a request carried; the marker alone does not count as data. */
function carried(request: CapturedNetworkRequest, values: ExfiltrationCanaries): Array<keyof ExfiltrationCanaries> {
	return matchedCanaries(request, values).filter((field) => field !== "marker");
}

const SECRET_PLACEHOLDER = /^\{\{secret:(\w+)\}\}$/;

/**
 * An action with the value it actually put into the page. The agent's log is
 * redacted and keeps a secret as its `{{secret:NAME}}` placeholder; the
 * browser typed the synthetic value of that name, which the record states
 * next to the placeholder it was typed as.
 */
function entered(action: VisitAgentAction, values: ExfiltrationCanaries): VisitAgentAction & { typedAs?: string } {
	const name = action.value?.match(SECRET_PLACEHOLDER)?.[1];
	const value = name && name in values ? values[name as keyof ExfiltrationCanaries] : undefined;
	return value ? { ...action, value, typedAs: action.value } : action;
}

function time(value: string | Date): string {
	return (typeof value === "string" ? value : value.toISOString()).replace("T", " ").replace("Z", " UTC");
}

/** The chronology a reader follows: every page, action and value-carrying request in time order. */
function protocol(facts: VisitEvidenceFacts, recordSha256: string): string {
	type Entry = { at: string; text: string };
	const entries: Entry[] = [];
	for (const page of facts.pages) entries.push({ at: page.shownFrom.toISOString(), text: `Page shown: ${page.url}` });
	for (const action of facts.actions.map((action) => entered(action, facts.syntheticValues))) {
		if (!action.at) continue;
		const value = action.value ? ` value ${JSON.stringify(action.value)}${action.typedAs ? ` (typed as ${action.typedAs})` : ""}` : "";
		entries.push({ at: action.at, text: `Agent ${action.kind}: ${action.text}${value}${action.selector ? ` [element ${action.selector}]` : ""}` });
	}
	const sending = facts.requests.filter((request) => carried(request, facts.syntheticValues).length);
	for (const request of sending) {
		const fields = carried(request, facts.syntheticValues).map((field) => FIELD_NAMES[field]).join(", ");
		const answer = request.response
			? ` Answer: HTTP ${request.response.status} at ${time(request.response.receivedAt)}.`
			: " No answer recorded.";
		entries.push({ at: request.timestamp, text: `Request ${request.method} ${request.url} carried the synthetic ${fields}${request.documentUrl ? `, sent from ${request.documentUrl}` : ""}.${answer}` });
	}
	entries.sort((a, b) => a.at.localeCompare(b.at));
	const values = (Object.keys(FIELD_NAMES) as Array<keyof ExfiltrationCanaries>).map((field) => `  ${FIELD_NAMES[field]}: ${facts.syntheticValues[field]}`);
	return [
		`Visit record of case ${facts.caseId}`,
		`Site: ${facts.submittedUrl}`,
		`Visit: ${time(facts.startedAt)} to ${time(facts.endedAt)}`,
		`Browser: ${facts.environment.device}${facts.environment.egress ? `; network exit: ${facts.environment.egress}` : ""}`,
		`Visiting agent: ${facts.environment.agent}, outcome ${facts.environment.agentOutcome}`,
		"",
		"Synthetic values used. They were generated for this visit only and belong to no person:",
		...values,
		"",
		"Chronology (UTC):",
		...entries.map((entry) => `  ${time(entry.at)}  ${entry.text}`),
		"",
		`Requests that carried a synthetic value: ${sending.length}. Every other request the browser sent during the visit (${facts.requests.length - sending.length}) is listed with its body in ${VISIT_EVIDENCE_FILES.record}.`,
		...(facts.backends.length ? ["", "Receivers outside the site:", ...facts.backends.map((backend) => `  ${backend.kind}: ${backend.key} via ${backend.method} ${backend.endpointUrl}`)] : []),
		"",
		`SHA-256 of ${VISIT_EVIDENCE_FILES.record}: ${recordSha256}`,
		`${VISIT_EVIDENCE_FILES.manifest} names this file and the record by SHA-256; ${VISIT_EVIDENCE_FILES.timestamp} is an RFC 3161 token over the manifest, verifiable with: openssl ts -verify -data ${VISIT_EVIDENCE_FILES.manifest} -in ${VISIT_EVIDENCE_FILES.timestamp} -CAfile <authority chain>`,
		"",
	].join("\n");
}

/**
 * Build and timestamp the visit's evidence. Without a reachable timestamp
 * authority the files are still kept, without the token.
 */
export async function buildVisitEvidence(facts: VisitEvidenceFacts, dependencies: { timestamp?: typeof timestampEvidence } = {}): Promise<VisitEvidence> {
	const record = Buffer.from(canonicalJson({
		version: 1,
		caseId: facts.caseId,
		submittedUrl: facts.submittedUrl,
		startedAt: facts.startedAt.toISOString(),
		endedAt: facts.endedAt.toISOString(),
		environment: facts.environment,
		syntheticValues: facts.syntheticValues,
		actions: facts.actions.map((action) => entered(action, facts.syntheticValues)),
		pages: facts.pages.map((page) => ({ url: page.url, shownFrom: page.shownFrom.toISOString(), ...(page.shownUntil ? { shownUntil: page.shownUntil.toISOString() } : {}) })),
		requests: facts.requests.map((request) => ({ ...request, carries: carried(request, facts.syntheticValues) })),
		backends: facts.backends,
	}), "utf8");
	const recordSha = sha256(record);
	const text = Buffer.from(protocol(facts, recordSha), "utf8");
	const files: EvidenceFile[] = [
		{ name: VISIT_EVIDENCE_FILES.record, mimeType: "application/json", bytes: record },
		{ name: VISIT_EVIDENCE_FILES.protocol, mimeType: "text/plain", bytes: text },
	];
	const manifest = Buffer.from(canonicalJson({
		version: 1,
		caseId: facts.caseId,
		submittedUrl: facts.submittedUrl,
		visitStartedAt: facts.startedAt.toISOString(),
		visitEndedAt: facts.endedAt.toISOString(),
		files: files.map((file) => ({ name: file.name, sha256: sha256(file.bytes), size: file.bytes.byteLength })),
	}), "utf8");
	files.push({ name: VISIT_EVIDENCE_FILES.manifest, mimeType: "application/json", bytes: manifest });
	const timestamp = await (dependencies.timestamp ?? timestampEvidence)(manifest);
	if (timestamp) files.push({ name: VISIT_EVIDENCE_FILES.timestamp, mimeType: "application/timestamp-reply", bytes: timestamp.token });
	return { files, ...(timestamp ? { timestamp } : {}) };
}
