import { describe, expect, test } from "bun:test";

import { serviceIdentity, serviceUserAgent } from "../../../network/service_identity";
import { SubmissionsEntity } from "../../../db/entities/submissions";
import { useTemporaryDatabase } from "../../../db/test_helpers";
import { AbuseRepository } from "../../repository";
import { resolveAbuseTarget } from "../../resolver";
import { reportConfirmedEmailPhishing, reportConfirmedWebsiteAbuse } from "../../submission_reports";
import { executeProviderSubmission } from "../submission_execution";
import { NETCRAFT_MAIL_PROVIDER } from "./definition";
import { netcraftMailDraft, netcraftMailMessage, prepareNetcraftMailExternalSubmission, submitNetcraftMailSubmission } from "./submission";
import { defineProvider } from "../kit/provider";
import { type FetchLike } from "../../../http/fetch";

useTemporaryDatabase();

const bounce = [
	"To: [redacted] <[redacted]>",
	"Subject: Undelivered Mail Returned to Sender",
	"Message-ID: <2054a720@localhost>",
	"Content-Type: text/plain; charset=utf-8",
	"",
	"This is the mail system at host my8.interlink.or.jp.",
].join("\r\n");

/** The provider as the registry wires it, with Netcraft's answer replaced. */
const providerAnswering = (fetch: FetchLike) => defineProvider({
	definition: NETCRAFT_MAIL_PROVIDER,
	draft: netcraftMailDraft,
	external: { prepare: prepareNetcraftMailExternalSubmission, submit: (context, preflight) => submitNetcraftMailSubmission(context, preflight, { fetch }) },
});

async function emailRoute(eml: string, submissionId = 371157972019056816n) {
	await SubmissionsEntity.create({ id: submissionId, kind: "email", data: { kind: "email" }, dedupeKey: `netcraft-mail-${submissionId.toString()}` });
	const report = await reportConfirmedEmailPhishing({ submissionId, analysisText: "A phishing email impersonating a bank.", redactedEml: eml, reporter: {} });
	const [target] = await AbuseRepository.listTargets(report.reportId);
	const resolved = await resolveAbuseTarget(target!);
	expect(resolved.routes.map((route) => route.providerRegistryKey)).toEqual([NETCRAFT_MAIL_PROVIDER.key]);
	return AbuseRepository.upsertResolvedRoute(target!.id, resolved.routes[0]!);
}

describe("Netcraft mail provider", () => {
	test("adds an explicit unknown sender only to a message whose From header carries no address", () => {
		expect(netcraftMailMessage(bounce)).toBe(`From: Unknown sender <unknown-sender@invalid>\r\n${bounce}`);
		const empty = "From: \r\nSubject: x\r\n\r\nbody";
		expect(netcraftMailMessage(empty)).toBe("From: Unknown sender <unknown-sender@invalid>\r\nSubject: x\r\n\r\nbody");
		const normal = "From: Wallet <notice@example.com>\r\nSubject: x\r\n\r\nbody";
		expect(netcraftMailMessage(normal)).toBe(normal);
		const folded = "From: \"Wallet\"\r\n <notice@example.com>\r\nSubject: x\r\n\r\nbody";
		expect(netcraftMailMessage(folded)).toBe(folded);
	});

	test("is the only route for the email target and submits the stored message once", async () => {
		const route = await emailRoute(bounce);
		const requests: Array<{ url: string; userAgent: string | null; body: { email: string; message: string } }> = [];
		const provider = providerAnswering(async (input, init) => {
			requests.push({ url: String(input), userAgent: new Headers(init?.headers).get("user-agent"), body: JSON.parse(String(init?.body)) });
			return new Response(JSON.stringify({ message: "Successfully reported", uuid: "cccccccccccccccccccccccccccccccc" }));
		});
		await expect(executeProviderSubmission({ routeId: route.id, provider })).resolves.toMatchObject({ outcome: "submitted" });
		await expect(executeProviderSubmission({ routeId: route.id, provider })).resolves.toEqual({ outcome: "not_eligible" });
		expect(requests).toHaveLength(1);
		expect(requests[0]).toEqual({
			url: NETCRAFT_MAIL_PROVIDER.reportMailUrl,
			userAgent: serviceUserAgent,
			body: { email: serviceIdentity.mailbox, message: `From: Unknown sender <unknown-sender@invalid>\r\n${bounce}` },
		});
		const [run] = await AbuseRepository.listProviderRunsForReport(route.reportId);
		expect(run).toMatchObject({ executionStatus: "completed", confirmationId: "cccccccccccccccccccccccccccccccc", submittedTargets: ["phishing-email"] });
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "submitted" });
	});

	test("records an explicit Netcraft rejection as a known provider outcome", async () => {
		const route = await emailRoute("From: a@example.com\r\nSubject: x\r\n\r\nbody", 371157972019056817n);
		const provider = providerAnswering(async () => new Response(JSON.stringify({ error: "Bad Request" }), { status: 400 }));
		await expect(executeProviderSubmission({ routeId: route.id, provider })).resolves.toMatchObject({ outcome: "provider_rejected" });
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "provider_rejected" });
	});

	test("refuses a message whose stored evidence changed after preparation before the marker, and sends nothing", async () => {
		const route = await emailRoute("From: a@example.com\r\nSubject: x\r\n\r\nbody", 371157972019056818n);
		const prepared = await netcraftMailDraft.prepare({ routeId: route.id, payload: {} });
		if (prepared.outcome !== "ready") throw new Error("Expected a ready Netcraft mail payload.");
		const tampered = { ...prepared.payload, message: { ...(prepared.payload.message as Record<string, unknown>), sha256: "0".repeat(64) } };
		await expect(netcraftMailDraft.verify({ routeId: route.id, payload: tampered })).rejects.toThrow("no longer matches the report");
	});

	test("never applies to a website report", async () => {
		await SubmissionsEntity.create({ id: 371157972019056819n, kind: "website", data: { kind: "website", website: { url: "https://login.example.com/" } }, dedupeKey: "netcraft-mail-website" });
		const report = await reportConfirmedWebsiteAbuse({ submissionId: 371157972019056819n, urls: ["https://login.example.com/"], analysisText: "Credential page.", reporter: {}, finding: { finding: "phishing", phishingBasis: "credential_theft" } });
		const [target] = await AbuseRepository.listTargets(report.reportId);
		const resolved = await resolveAbuseTarget(target!, {
			fetch: async () => new Response("{}", { status: 404 }),
			assertPublicHost: async () => undefined,
			resolveDomainAddresses: async () => [],
			port43Query: async () => "",
		});
		expect(resolved.routes.map((route) => route.providerRegistryKey)).not.toContain(NETCRAFT_MAIL_PROVIDER.key);
	});
});
