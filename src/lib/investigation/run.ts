import { reportRedirector } from "../abuse/origin/redirector_report";
import { AbuseRepository } from "../abuse/repository";
import { errorText } from "../util/error_text";
import { downloadPipelineConfigFromEnvironment, investigateSample, type DownloadPipelineConfig } from "../exfiltration/downloads/pipeline";
import { awaitVirusTotalVerdict } from "../exfiltration/downloads/virustotal";
import { enrichBackendIdentity } from "../exfiltration/identity";
import { reportExfiltrationBackend } from "../exfiltration/reporting";
import type { ExfiltrationBackend } from "../exfiltration/types";
import { downloaderUserAgent, fetchPayload, type FetchedPayload } from "../malware/payload_fetch";
import { payloadEvidence, payloadVerdictSentence, type PayloadEvidence } from "../malware/payload_evidence";
import { reportDataDrop, reportPayloadHost, type PayloadDelivery } from "../malware/payload_host_report";
import type { ReporterMetadata } from "../http/reporter_headers";
import { defangCommand } from "../malware/defang";
import { isSameWebsite } from "../website/info/site";
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
	reportRedirector: typeof reportRedirector;
	/** Name the bot, webhook, or host behind a data drop from its own API, where it has one. */
	enrich(backend: ExfiltrationBackend, signal?: AbortSignal): Promise<ExfiltrationBackend>;
	reportBackend: typeof reportExfiltrationBackend;
	now(): Date;
};

function defaultDependencies(): InvestigationDependencies {
	return {
		fetchPayload: (url, userAgent, signal) => fetchPayload(url, userAgent, signal ? { signal } : {}),
		pipelineConfig: () => downloadPipelineConfigFromEnvironment(),
		investigateSample,
		awaitVerdict: awaitVirusTotalVerdict,
		reportPayloadHost,
		reportDataDrop,
		reportRedirector,
		enrich: (backend, signal) => enrichBackendIdentity(backend, globalThis.fetch, signal),
		reportBackend: reportExfiltrationBackend,
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
		// The file the page hands out, fetched again as the browser that got it.
		...(payload.offeredDownload ? [{
			url: payload.offeredDownload.url,
			delivery: { kind: "offered_download" as const, downloadedOn: payload.offeredDownload.pageUrl, userAgent: payload.offeredDownload.userAgent },
		}] : []),
	];
}

/** How the page delivers the file, as a finding names it. */
function deliveryPhrase(delivery: PayloadDelivery, url: string): { refused: string; fetched: string } {
	if (delivery.kind === "paste_command") {
		return { refused: `The payload host for the command ${JSON.stringify(defangCommand(delivery.command))}`, fetched: "the payload from {url} as the command does" };
	}
	if (delivery.kind === "offered_download") {
		return { refused: `The host of the file the page offers, ${url},`, fetched: "the file the page offers, {url}, as the browser that got it" };
	}
	return { refused: `The host of the exploit loader's file ${url}`, fetched: "the exploit loader's file {url} as the browser it attacks would" };
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
		const phrase = deliveryPhrase(delivery, url);
		if (!evidence) return [`${phrase.refused} refused the download during our check (${error}).`];
		return [
			`We downloaded ${phrase.fetched.replace("{url}", evidence.url)} (${evidence.sizeBytes} bytes, SHA-256 ${evidence.sha256}) and did not run it.`,
			payloadVerdictSentence(evidence),
		];
	});
}

function dataDropFindings(backends: readonly ExfiltrationBackend[]): string[] {
	if (!backends.length) return [];
	return [`In our visit with synthetic data, the site sent what was entered to: ${backends.map((backend) => backend.kind === "domain" ? backend.hostname : backend.key).join(", ")}.`];
}

/**
 * Collect every piece of evidence about a confirmed site before its report
 * reaches a provider, then release the report. A failed step never
 * holds the report back: it is sent with what was collected, and the failure
 * is recorded on the case.
 */
export async function runReportInvestigation(
	params: { reportId: bigint; payload: InvestigationJobPayload; reporter: ReporterMetadata; signal?: AbortSignal },
	dependencies: Partial<InvestigationDependencies> = {},
): Promise<void> {
	const deps = { ...defaultDependencies(), ...dependencies };
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
	let screenshot: ReturnType<typeof lurePageScreenshot> | undefined;
	const lureScreenshot = () => (screenshot ??= lurePageScreenshot(reportId));
	const pageScreenshot = linkedPayloads.length || dataDrops.length ? await lureScreenshot() : undefined;
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

	// The link the campaign hands out, when the page was reached through one:
	// it outlives this page and forwards to the next. Idempotent like the
	// payload reports, so a retried job finds its report.
	const redirector = await deps.reportRedirector({ reportId, submissionId, finding: payload.finding, reporter, pageScreenshot: lureScreenshot, signal });
	if (redirector) {
		await AbuseRepository.appendEvent({
			reportId,
			eventType: `redirector.${redirector.kind}`,
			data: redirector.kind === "reported"
				? { url: redirector.url, reportId: redirector.report.reportId.toString(), created: redirector.report.created }
				: { url: redirector.url, reason: redirector.reason },
		});
	}

	// Each place the visit saw the site send the synthetic values gets a report
	// of its own: a Telegram bot, a Discord webhook, a collector host. Reports
	// are idempotent, so a retried job finds the ones it made.
	const reportedDrops: ExfiltrationBackend[] = [];
	const backendScreenshot = payload.dataDrops?.length ? await lureScreenshot() : undefined;
	for (const backend of payload.dataDrops ?? []) {
		signal?.throwIfAborted();
		const enriched = await deps.enrich(backend, signal).catch(() => backend);
		reportedDrops.push(enriched);
		await deps.reportBackend({
			submissionId,
			sourceReportId: reportId,
			backend: enriched,
			pageUrl: payload.pageUrl,
			observedAt: new Date(enriched.request.timestamp),
			...(backendScreenshot ? { pageScreenshot: backendScreenshot } : {}),
			reporter,
		});
	}

	const findings = [...payloadFindings(payloads), ...dataDropFindings(reportedDrops)];
	const evidence = payloads.flatMap(({ evidence: item }) => item ? [{
		filename: `payload-${item.sha256.slice(0, 16)}.json`,
		mimeType: "application/json",
		buffer: Buffer.from(JSON.stringify(item, null, 2), "utf8"),
		metadata: { payloadSha256: item.sha256 },
	}] : []);
	await AbuseRepository.releaseInvestigatedReport({ reportId, findings, evidence });
	await setInvestigationStatus(submissionId, {
		status: "completed",
		backendCount: reportedDrops.length,
		payloads: payloads.map(({ url, evidence: item, error }) => item
			? { url: item.url, sha256: item.sha256, sizeBytes: item.sizeBytes, ...(item.knownVerdict ? { verdict: `${item.knownVerdict.provider}: ${item.knownVerdict.verdict}` } : {}) }
			: { url, ...(error ? { error } : {}) }),
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
