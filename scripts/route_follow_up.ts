/**
 * Send an operator-written follow-up on an existing abuse route and record it
 * on the case, through the app's own channels:
 *
 * - `email`: `sendAbuseEmailRoute` on the route's latest run (SMTP relay,
 *   service From, a route-owned abuse-<token>@ reply address, MIME artifact
 *   and outbound mail record). `reuseReplyAddress` answers on the route's
 *   existing thread: the reply address of its last outbound mail.
 * - `netcraft_issue`: Netcraft's "Report an issue" on the route's submission
 *   (`POST /api/v3/submission/<uuid>/report_issue`), recorded as an outbound
 *   provider message before the request and settled after it.
 *
 * Every follow-up appends a route event: `provider_decision.followed_up` when
 * it answers a provider decision (`decisionState`, shown on the case page),
 * else `route.follow_up_sent`.
 *
 * Run inside the app container, the request as JSON on stdin:
 *   docker exec -i -w /app <container> bun scripts/route_follow_up.ts [--dry-run] < request.json
 */
import { sendAbuseEmailRoute } from "../src/lib/abuse/mail/send";
import { AbuseRepository } from "../src/lib/abuse/repository";

type Attachment = { filename: string; mimeType: string; contentBase64: string };

type Request = {
	routeId: string;
	/** One or two sentences for the case page: what was sent and what it asks for. */
	summary: string;
	/** The provider decision this answers (e.g. `no threats`), if any. */
	decisionState?: string;
} & (
	| { channel: "email"; to: string; subject: string; body: string; attachments?: Attachment[]; reuseReplyAddress?: boolean }
	| { channel: "netcraft_issue"; urls: Array<{ url: string; reason: string }>; additionalInfo: string }
);

const NETCRAFT_SUBMISSION_API = "https://report.netcraft.com/api/v3/submission/";

const dryRun = process.argv.includes("--dry-run");
const request = JSON.parse(await Bun.stdin.text()) as Request;

const route = await AbuseRepository.getRoute(BigInt(request.routeId));
if (!route) throw new Error(`Route ${request.routeId} does not exist.`);
const run = await AbuseRepository.getLatestProviderRunForRoute(route.id);
if (!run) throw new Error(`Route ${request.routeId} has no provider run to follow up.`);
const at = new Date().toISOString();
const correlationKey = request.decisionState
	? `decision-follow-up:${route.id}:${request.decisionState}`
	: `follow-up:${route.id}:${at}`;
const mail = await AbuseRepository.listMailForReport(route.reportId);
// A refused attempt filed nothing and may be retried; any other record may have reached the provider.
if (mail.some((message) => message.direction === "outbound" && message.correlationKey === correlationKey && message.status !== "failed")) {
	throw new Error(`A follow-up under ${correlationKey} was already sent.`);
}

const result = request.channel === "email" ? await sendEmail(request) : await reportNetcraftIssue(request);
if (result === undefined) process.exit(0);

await AbuseRepository.appendEvent({
	reportId: route.reportId,
	routeId: route.id,
	eventType: request.decisionState ? "provider_decision.followed_up" : "route.follow_up_sent",
	data: {
		...(request.decisionState ? { state: request.decisionState, detail: null, confirmationId: run.confirmationId } : {}),
		to: result.to,
		summary: request.summary,
		messageId: result.messageId,
		channel: request.channel,
	},
});
console.log(JSON.stringify({ routeId: request.routeId, correlationKey, ...result }, null, 2));

async function sendEmail(request: Extract<Request, { channel: "email" }>) {
	const replyAddress = request.reuseReplyAddress
		? mail.filter((message) => message.direction === "outbound" && message.routeId === route!.id && message.replyAddress).at(-1)?.replyAddress ?? undefined
		: undefined;
	if (request.reuseReplyAddress && !replyAddress) throw new Error(`Route ${request.routeId} has no outbound mail whose reply address could be reused.`);
	const attachments = (request.attachments ?? []).map(({ filename, mimeType, contentBase64 }) => ({ filename, mimeType, content: Buffer.from(contentBase64, "base64") }));
	if (dryRun) {
		console.log(JSON.stringify({ dryRun: true, to: request.to, subject: request.subject, replyAddress: replyAddress ?? "(new)", runId: run!.id.toString(), correlationKey, attachments: attachments.map((file) => `${file.filename} ${file.mimeType} ${file.content.byteLength}B`) }, null, 2));
		console.log(request.body);
		return undefined;
	}
	const sent = await sendAbuseEmailRoute({
		routeId: route!.id,
		runId: run!.id,
		reportId: route!.reportId,
		recipient: request.to,
		subject: request.subject,
		body: request.body,
		attachments,
		correlationKey,
		...(replyAddress ? { replyAddress } : {}),
	});
	if (sent.status !== "sent") throw new Error(`The follow-up to ${request.to} was not confirmed sent (${sent.status}): ${sent.error ?? ""}`);
	return { to: request.to, status: sent.status, messageId: sent.rfcMessageId ?? null, mailRecordId: sent.messageId.toString(), replyAddress: replyAddress ?? "(new)" };
}

async function reportNetcraftIssue(request: Extract<Request, { channel: "netcraft_issue" }>) {
	const uuid = run!.confirmationId;
	if (!uuid || route!.providerRegistryKey !== "netcraft") throw new Error(`Route ${request.routeId} is not a Netcraft route with a submission.`);
	// The API refuses an empty `hash_misclassifications` ("Properties not allowed").
	const body = { url_misclassifications: request.urls, additional_info: request.additionalInfo };
	const to = `Netcraft report issue (submission ${uuid})`;
	const subject = `Issue report: misclassified URLs in Netcraft submission ${uuid}`;
	const textBody = [...request.urls.map(({ url, reason }) => `${url}\n${reason}`), request.additionalInfo].join("\n\n");
	if (dryRun) {
		console.log(JSON.stringify({ dryRun: true, to, subject, correlationKey, body }, null, 2));
		return undefined;
	}
	const recorded = await AbuseRepository.createOutboundProviderMessage({ reportId: route!.reportId, routeId: route!.id, runId: run!.id, to, subject, textBody, correlationKey });
	let response: Response;
	try {
		response = await fetch(`${NETCRAFT_SUBMISSION_API}${encodeURIComponent(uuid)}/report_issue`, {
			method: "POST",
			headers: { accept: "application/json", "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	} catch (error) {
		throw new Error(`The Netcraft issue report may have been filed (record ${recorded} left pending): ${error instanceof Error ? error.message : String(error)}`);
	}
	const answer = await response.text();
	if (!response.ok) {
		await AbuseRepository.settleOutboundMail({ messageId: recorded, status: "failed", error: `HTTP ${response.status}: ${answer.slice(0, 500)}` });
		throw new Error(`Netcraft refused the issue report: HTTP ${response.status} ${answer.slice(0, 500)}`);
	}
	await AbuseRepository.settleOutboundMail({ messageId: recorded, status: "sent" });
	return { to, status: "sent", messageId: recorded.toString(), netcraftAnswer: answer.slice(0, 500) };
}
