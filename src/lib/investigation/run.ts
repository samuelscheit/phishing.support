import { AbuseRepository } from "../abuse/repository";
import type { AbuseSkyvernAdapter } from "../abuse/skyvern/adapter";
import { redactExternalError } from "../abuse/skyvern/adapter";
import { errorText } from "../error_text";
import { downloadPipelineConfigFromEnvironment, investigateSample, type DownloadPipelineConfig } from "../exfiltration/downloads/pipeline";
import { awaitVirusTotalVerdict } from "../exfiltration/downloads/virustotal";
import { runExfiltrationProbe, type ExfiltrationProbeResult } from "../exfiltration/probe";
import { downloaderUserAgent, fetchPayload, type FetchedPayload } from "../malware/payload_fetch";
import { payloadEvidence, payloadVerdictSentence, type PayloadEvidence } from "../malware/payload_evidence";
import { reportDataDrop, reportPayloadHost, type PayloadDelivery } from "../malware/payload_host_report";
import type { ReporterMetadata } from "../request_metadata";
import { defangCommand, defangUrl } from "../malware/defang";
import { isSameWebsite } from "../website_site";
import type { InvestigationJobPayload } from "./payload";
import { setInvestigationStatus } from "./status";

/** Payloads fetched per case: a command's few, plus an exploit loader's stages. */
const MAX_PAYLOADS = 12;

export type InvestigationDependencies = {
	fetchPayload(url: string, userAgent: string, signal?: AbortSignal): Promise<FetchedPayload>;
	pipelineConfig(): DownloadPipelineConfig;
	investigateSample: typeof investigateSample;
	awaitVerdict: typeof awaitVirusTotalVerdict;
	reportPayloadHost: typeof reportPayloadHost;
	reportDataDrop: typeof reportDataDrop;
	probe(input: Parameters<typeof runExfiltrationProbe>[0], signal?: AbortSignal): Promise<ExfiltrationProbeResult>;
	now(): Date;
};

function defaultDependencies(adapter: () => Pick<AbuseSkyvernAdapter, "createTask" | "getRun" | "cancelRun">): InvestigationDependencies {
	return {
		fetchPayload: (url, userAgent, signal) => fetchPayload(url, userAgent, signal ? { signal } : {}),
		pipelineConfig: () => downloadPipelineConfigFromEnvironment(),
		investigateSample,
		awaitVerdict: awaitVirusTotalVerdict,
		reportPayloadHost,
		reportDataDrop,
		probe: (input, signal) => runExfiltrationProbe(input, adapter(), signal),
		now: () => new Date(),
	};
}

type PayloadResult = { url: string; delivery: PayloadDelivery; evidence?: PayloadEvidence; error?: string };

/** Every payload the page gets onto a visitor's device, with how it does. */
function payloadSources(payload: InvestigationJobPayload): Array<{ url: string; delivery: PayloadDelivery }> {
	return [
		...payload.pasteCommands.flatMap((command) => command.payloadUrls.map((url) => ({
			url,
			delivery: { kind: "paste_command" as const, command: command.shown, interpreters: command.interpreters },
		}))),
		...(payload.exploitLoader?.stageUrls ?? []).map((url) => ({
			url,
			delivery: { kind: "exploit_stage" as const, frameUrl: payload.exploitLoader!.frameUrl, userAgent: payload.exploitLoader!.userAgent },
		})),
	];
}

function deliveryUserAgent(delivery: PayloadDelivery): string {
	return delivery.kind === "paste_command" ? downloaderUserAgent(delivery.interpreters) : delivery.userAgent;
}

/**
 * Download, hash, and judge every payload the page gets onto its visitors'
 * devices, as the client that runs it would request it. A payload a database
 * already knows keeps that verdict; one nobody knows is submitted for public
 * analysis and its verdict awaited, so the report can cite it. A host that
 * refuses the download is recorded, not retried.
 */
async function investigatePayloads(
	sources: ReadonlyArray<{ url: string; delivery: PayloadDelivery }>,
	deps: InvestigationDependencies,
	signal: AbortSignal | undefined,
): Promise<PayloadResult[]> {
	const config = deps.pipelineConfig();
	const results: PayloadResult[] = [];
	const seen = new Set<string>();
	for (const { url, delivery } of sources) {
		if (seen.has(url) || seen.size >= MAX_PAYLOADS) continue;
		seen.add(url);
		signal?.throwIfAborted();
		let fetched: FetchedPayload;
		try {
			fetched = await deps.fetchPayload(url, deliveryUserAgent(delivery), signal);
		} catch (error) {
			if (signal?.aborted) throw error;
			results.push({ url, delivery, error: errorText(error) });
			continue;
		}
		const fetchedAt = deps.now();
		const outcome = await deps.investigateSample({ bytes: fetched.body, remoteName: fetched.fileName }, config);
		let evidence = payloadEvidence({ ...fetched, fetchedAt, sizeBytes: fetched.body.byteLength, outcome });
		const analysis = evidence.submittedAnalyses.find((submitted) => submitted.provider === "virustotal");
		if (!evidence.knownVerdict && analysis) {
			const verdict = await deps.awaitVerdict({ sha256: evidence.sha256, analysisId: analysis.analysisId, apiKey: config.virusTotalApiKey, ...(signal ? { signal } : {}) });
			if (verdict.state === "known") evidence = { ...evidence, knownVerdict: { provider: verdict.provider, verdict: verdict.verdict } };
		}
		results.push({ url, delivery, evidence });
	}
	return results;
}

function payloadFindings(results: readonly PayloadResult[]): string[] {
	return results.flatMap(({ url, delivery, evidence, error }) => {
		if (!evidence) {
			return [delivery.kind === "paste_command"
				? `The payload host for the command ${JSON.stringify(defangCommand(delivery.command))} refused the download during our check (${error}).`
				: `The host of the exploit loader's file ${defangUrl(url)} refused the download during our check (${error}).`];
		}
		return [
			delivery.kind === "paste_command"
				? `We downloaded the payload from ${defangUrl(evidence.url)} as the command does (${evidence.sizeBytes} bytes, SHA-256 ${evidence.sha256}) and did not run it.`
				: `We downloaded the exploit loader's file ${defangUrl(evidence.url)} as the browser it attacks would (${evidence.sizeBytes} bytes, SHA-256 ${evidence.sha256}) and did not run it.`,
			payloadVerdictSentence(evidence),
		];
	});
}

function probeFindings(result: ExfiltrationProbeResult): string[] {
	const findings: string[] = [];
	if (result.backends.length) {
		findings.push(`In a controlled test with synthetic data, the page sent what was typed to: ${result.backends.map((backend) => backend.kind === "domain" ? backend.hostname : backend.key).join(", ")}.`);
	}
	for (const download of result.downloads) {
		if (!download.outcome) continue;
		const known = download.outcome.action.action === "record_known_verdict" ? download.outcome.action : undefined;
		findings.push(`The page's download control delivered a file with SHA-256 ${download.outcome.sha256}${known ? `, which ${known.provider} classifies as ${known.verdict}` : ""}.`);
	}
	return findings;
}

/**
 * Collect every piece of evidence about a confirmed site before its report
 * reaches a provider, then release the report. A failed probe step never
 * holds the report back: it is sent with what was collected, and the failure
 * is recorded on the case.
 */
export async function runReportInvestigation(
	params: { reportId: bigint; payload: InvestigationJobPayload; reporter: ReporterMetadata; signal?: AbortSignal },
	adapter: () => Pick<AbuseSkyvernAdapter, "createTask" | "getRun" | "cancelRun">,
	dependencies: Partial<InvestigationDependencies> = {},
): Promise<void> {
	const deps = { ...defaultDependencies(adapter), ...dependencies };
	const { reportId, payload, reporter, signal } = params;
	const submissionId = BigInt(payload.submissionId);
	const report = await AbuseRepository.getReport(reportId);
	if (report?.status !== "investigating") return;
	await setInvestigationStatus(submissionId, { status: "running", updatedAt: deps.now().toISOString() });

	const payloads = await investigatePayloads(payloadSources(payload), deps, signal);
	// A payload or data drop on the page's own site is covered by the page's
	// report; only another host gets a linked report of its own.
	const linkedPayloads = payloads.filter(({ evidence }) => evidence && !isSameWebsite(evidence.url, payload.pageUrl));
	const dataDrops = (payload.exploitLoader?.dataUploads ?? []).filter((upload) => !isSameWebsite(upload.url, payload.pageUrl));
	const pageScreenshot = linkedPayloads.length || dataDrops.length ? await lurePageScreenshot(reportId) : undefined;
	for (const { delivery, evidence } of linkedPayloads) {
		await deps.reportPayloadHost({
			submissionId,
			sourceReportId: reportId,
			pageUrl: payload.pageUrl,
			delivery,
			payload: evidence!,
			...(pageScreenshot ? { pageScreenshot } : {}),
			reporter,
		});
	}
	for (const upload of dataDrops) {
		await deps.reportDataDrop({
			submissionId,
			sourceReportId: reportId,
			pageUrl: payload.pageUrl,
			frameUrl: payload.exploitLoader!.frameUrl,
			upload,
			...(pageScreenshot ? { pageScreenshot } : {}),
			reporter,
		});
	}

	let probe: ExfiltrationProbeResult | undefined;
	let probeError: string | undefined;
	// A drive-by exploit takes nothing a visitor types or downloads: there is
	// no form or download for the probe to try, only the decoy in front of it.
	if (!payload.exploitLoader) {
		try {
			probe = await deps.probe({ reportId, submissionId, pageUrl: payload.pageUrl, reporter }, signal);
		} catch (error) {
			if (signal?.aborted) throw error;
			// A retryable browser-service failure retries the whole job; the payload
			// reports above are idempotent, so a retry re-fetches without duplicating them.
			if ((error as { retryable?: unknown } | null)?.retryable !== false) throw error;
			probeError = redactExternalError(error);
		}
	}

	const findings = [...payloadFindings(payloads), ...(probe ? probeFindings(probe) : [])];
	const evidence = payloads.flatMap(({ evidence: item }) => item ? [{
		filename: `payload-${item.sha256.slice(0, 16)}.json`,
		mimeType: "application/json",
		buffer: Buffer.from(JSON.stringify(item, null, 2), "utf8"),
		metadata: { payloadSha256: item.sha256 },
	}] : []);
	await AbuseRepository.releaseInvestigatedReport({ reportId, findings, evidence });
	await setInvestigationStatus(submissionId, {
		status: "completed",
		backendCount: probe?.backends.length ?? 0,
		payloads: payloads.map(({ url, evidence: item, error }) => item
			? { url: item.url, sha256: item.sha256, sizeBytes: item.sizeBytes, ...(item.knownVerdict ? { verdict: `${item.knownVerdict.provider}: ${item.knownVerdict.verdict}` } : {}) }
			: { url, ...(error ? { error } : {}) }),
		...(probeError ? { probeError } : {}),
		updatedAt: deps.now().toISOString(),
	});
}

/** The page report's screenshot, as captured evidence of the command a payload host serves. */
async function lurePageScreenshot(reportId: bigint): Promise<{ buffer: Buffer; mimeType: "image/png" | "image/jpeg" } | undefined> {
	const input = await AbuseRepository.getReportInput(reportId);
	const image = input?.evidenceArtifacts.find((artifact) => artifact.mimeType === "image/png" || artifact.mimeType === "image/jpeg");
	return image ? { buffer: Buffer.from(image.blob), mimeType: image.mimeType as "image/png" | "image/jpeg" } : undefined;
}

/**
 * A job that ran out of retries still owes the report its release: evidence
 * gathering is supplementary, and the confirmed site must be reported.
 */
export async function releaseAfterFailedInvestigation(reportId: bigint, submissionId: bigint | undefined, error: string): Promise<void> {
	await AbuseRepository.releaseInvestigatedReport({ reportId, findings: [], evidence: [] });
	if (submissionId !== undefined) await setInvestigationStatus(submissionId, { status: "failed", lastError: error, updatedAt: new Date().toISOString() });
}
