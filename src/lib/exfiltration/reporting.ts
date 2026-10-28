import type { ReporterMetadata } from "../request_metadata";
import { AbuseRepository, type CreatedAbuseReport } from "../abuse/repository";
import { normalizeAbuseTarget, normalizeObservedUrl, type NormalizedAbuseTarget, type ValidatedAbuseReportRequest } from "../abuse/contracts";
import { hashStableJson, sha256Hex, stableJson } from "../abuse/security";
import type { ExfiltrationBackend } from "./types";

function backendTarget(backend: ExfiltrationBackend): NormalizedAbuseTarget {
	let normalizedTarget: string;
	let targetType: NormalizedAbuseTarget["targetType"];
	if (backend.kind === "telegram_bot") {
		const botId = backend.telegram?.botId ?? backend.telegram?.token.split(":", 1)[0];
		if (!botId || !/^\d{1,20}$/.test(botId)) throw new Error("Telegram backend has no stable bot ID.");
		normalizedTarget = `telegram-bot:${botId}`;
		targetType = "service_account";
	} else if (backend.kind === "discord_webhook") {
		if (!backend.discord?.webhookId) throw new Error("Discord backend has no stable webhook ID.");
		normalizedTarget = `discord-webhook:${backend.discord.webhookId}`;
		targetType = "service_account";
	} else {
		const normalized = normalizeAbuseTarget(backend.hostname);
		normalizedTarget = normalized.normalizedTarget;
		targetType = normalized.targetType;
	}
	return {
		ordinal: 0,
		originalInput: normalizedTarget,
		originalInputs: [normalizedTarget],
		normalizedTarget,
		targetType,
		observedUrls: [normalizeObservedUrl(backend.endpointUrl)],
	};
}

function description(params: { backend: ExfiltrationBackend; pageUrl: string; observedAt: Date }): string {
	const { backend } = params;
	const identity = backend.kind === "telegram_bot"
		? `Telegram bot ID ${backend.telegram?.botId ?? backend.telegram?.token.split(":", 1)[0]}${backend.telegram?.username ? ` (@${backend.telegram.username})` : ""}; bot token ${backend.telegram?.token}${backend.telegram?.chatId ? `; chat ID ${backend.telegram.chatId}` : ""}`
		: backend.kind === "discord_webhook"
			? `Discord webhook ID ${backend.discord?.webhookId}; webhook token ${backend.discord?.token}${backend.discord?.guildId ? `; guild ID ${backend.discord.guildId}` : ""}${backend.discord?.channelId ? `; channel ID ${backend.discord.channelId}` : ""}`
			: `Collector host ${backend.hostname}`;
	return [
		`This backend received synthetic data entered into the confirmed phishing page ${params.pageUrl}.`,
		`Observed at ${params.observedAt.toISOString()} via ${backend.method} ${backend.endpointUrl}.`,
		`${identity}.`,
		`Matched probe fields: ${backend.matchedCanaries.join(", ")}. The values were synthetic and unique to this controlled probe; no victim data was accessed.`,
	].join("\n");
}

export function buildExfiltrationBackendRequest(params: {
	submissionId: bigint;
	sourceReportId: bigint;
	backend: ExfiltrationBackend;
	pageUrl: string;
	observedAt: Date;
}): ValidatedAbuseReportRequest {
	const target = backendTarget(params.backend);
	const reportDescription = description(params);
	const originalRequest = {
		kind: "exfiltration_backend",
		submissionId: params.submissionId.toString(),
		sourceReportId: params.sourceReportId.toString(),
		pageUrl: params.pageUrl,
		observedAt: params.observedAt.toISOString(),
		backend: params.backend,
	};
	const evidence = Buffer.from(stableJson(originalRequest), "utf8");
	const idempotencyKey = `exfil:${params.submissionId.toString()}:${sha256Hex(params.backend.key).slice(0, 32)}`;
	return {
		originalRequest,
		targets: [target],
		allegationCategory: "phishing",
		description: reportDescription,
		observedUrls: [{ target: target.normalizedTarget, urls: target.observedUrls }],
		evidence: [{ filename: "exfiltration-evidence.json", mimeType: "application/json", buffer: evidence, sha256: sha256Hex(evidence) }],
		idempotencyKey,
		requestPayloadHash: hashStableJson({ idempotencyKey, target, reportDescription, evidenceSha256: sha256Hex(evidence) }),
	};
}

export async function reportExfiltrationBackend(params: {
	submissionId: bigint;
	sourceReportId: bigint;
	backend: ExfiltrationBackend;
	pageUrl: string;
	observedAt: Date;
	reporter: ReporterMetadata;
}): Promise<CreatedAbuseReport> {
	return AbuseRepository.createReport({
		request: buildExfiltrationBackendRequest(params),
		reporter: params.reporter,
		submissionId: params.submissionId,
	});
}
