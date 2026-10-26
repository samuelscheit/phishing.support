import { describe, expect, test } from "bun:test";

import { serviceIdentity } from "../../../constants";
import { SubmissionsEntity } from "../../../db/entities";
import { useTemporaryDatabase } from "../../../db/test_helpers";
import { AbuseRepository } from "../../repository";
import { resolveAbuseTarget } from "../../resolver";
import { reportConfirmedEmailPhishing, reportConfirmedWebsitePhishing } from "../../submission_reports";
import { executeProviderSubmission } from "../submission_execution";
import type { ProviderSubmissionProvider } from "../submission_contracts";
import { NETCRAFT_MAIL_PROVIDER } from "./definition";
import { netcraftMailMessage, prepareNetcraftMailSubmission, submitNetcraftMailSubmission } from "./submission";

useTemporaryDatabase();

const bounce = [
	"To: [redacted] <[redacted]>",
	"Subject: Undelivered Mail Returned to Sender",
	"Message-ID: <2054a720@localhost>",
	"Content-Type: text/plain; charset=utf-8",
	"",
	"This is the mail system at host my8.interlink.or.jp.",
].join("\r\n");

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
		const requests: Array<{ url: string; body: { email: string; message: string } }> = [];
		const provider: ProviderSubmissionProvider = {
			definition: NETCRAFT_MAIL_PROVIDER,
			prepareSubmission: prepareNetcraftMailSubmission,
			submit: (context) => submitNetcraftMailSubmission(context, {
				fetch: async (input, init) => {
					requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
					return new Response(JSON.stringify({ message: "Successfully reported", uuid: "cccccccccccccccccccccccccccccccc" }));
				},
			}),
		};
		await expect(executeProviderSubmission({ routeId: route.id, provider })).resolves.toMatchObject({ outcome: "submitted" });
		await expect(executeProviderSubmission({ routeId: route.id, provider })).resolves.toEqual({ outcome: "not_eligible" });
		expect(requests).toHaveLength(1);
		expect(requests[0]).toEqual({
			url: NETCRAFT_MAIL_PROVIDER.reportMailUrl,
			body: { email: serviceIdentity.mailbox, message: `From: Unknown sender <unknown-sender@invalid>\r\n${bounce}` },
		});
		const [run] = await AbuseRepository.listProviderRunsForReport(route.reportId);
		expect(run).toMatchObject({ executionStatus: "completed", confirmationId: "cccccccccccccccccccccccccccccccc", submittedTargets: ["phishing-email"] });
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "submitted" });
	});

	test("records an explicit Netcraft rejection as a known provider outcome", async () => {
		const route = await emailRoute("From: a@example.com\r\nSubject: x\r\n\r\nbody", 371157972019056817n);
		const provider: ProviderSubmissionProvider = {
			definition: NETCRAFT_MAIL_PROVIDER,
			prepareSubmission: prepareNetcraftMailSubmission,
			submit: (context) => submitNetcraftMailSubmission(context, {
				fetch: async () => new Response(JSON.stringify({ error: "Bad Request" }), { status: 400 }),
			}),
		};
		await expect(executeProviderSubmission({ routeId: route.id, provider })).resolves.toMatchObject({ outcome: "provider_rejected" });
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "provider_rejected" });
	});

	test("refuses to submit when the stored message evidence changed after preparation", async () => {
		const route = await emailRoute("From: a@example.com\r\nSubject: x\r\n\r\nbody", 371157972019056818n);
		const prepared = await prepareNetcraftMailSubmission({ routeId: route.id, payload: {} });
		if (prepared.outcome !== "ready") throw new Error("Expected a ready Netcraft mail payload.");
		const tampered = { ...prepared.payload, message: { ...(prepared.payload.message as Record<string, unknown>), sha256: "0".repeat(64) } };
		await expect(submitNetcraftMailSubmission({ routeId: route.id, payload: tampered }, { fetch: async () => { throw new Error("must not be called"); } }))
			.rejects.toThrow("no longer matches its report evidence");
	});

	test("never applies to a website report", async () => {
		await SubmissionsEntity.create({ id: 371157972019056819n, kind: "website", data: { kind: "website", website: { url: "https://login.example.com/" } }, dedupeKey: "netcraft-mail-website" });
		const report = await reportConfirmedWebsitePhishing({ submissionId: 371157972019056819n, url: "https://login.example.com/", analysisText: "Credential page.", reporter: {} });
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
