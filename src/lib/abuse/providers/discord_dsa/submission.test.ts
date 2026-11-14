import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { SubmissionsEntity } from "../../../db/entities";
import { useTemporaryDatabase } from "../../../db/test_helpers";
import { reportExfiltrationBackend } from "../../../exfiltration/reporting";
import type { ExfiltrationBackend } from "../../../exfiltration/types";
import { AbuseRepository } from "../../repository";
import { resolveAbuseTarget } from "../../resolver";
import { mailedCodeFrom } from "../mailed_code";
import { executeProviderSubmission } from "../submission_execution";
import type { ProviderSubmissionProvider } from "../submission_contracts";
import { DISCORD_DSA_PROVIDER } from "./definition";
import {
	discordDsaDescription,
	prepareDiscordDsaExternalSubmission,
	prepareDiscordDsaSubmission,
	submitDiscordDsaSubmission,
	type DiscordDsaDependencies,
	type DiscordDsaReport,
	type DiscordDsaSession,
} from "./submission";

useTemporaryDatabase();

const originalSecret = process.env.ABUSE_TRACKING_TOKEN_SECRET;
beforeAll(() => { process.env.ABUSE_TRACKING_TOKEN_SECRET = "discord-dsa-provider-test-secret-32-bytes"; });
afterAll(() => {
	if (originalSecret === undefined) delete process.env.ABUSE_TRACKING_TOKEN_SECRET;
	else process.env.ABUSE_TRACKING_TOKEN_SECRET = originalSecret;
});

/** The roblox2365.github.io kit (submission 379996268098752545) and the webhook its probe caught. */
const WEBHOOK_ID = "1547121100977344622";
const GUILD_ID = "1547120658775941120";
const CHANNEL_ID = "1547120931049316433";
const REPORTER = { DISCORD_DSA_REPORTER_NAME: "Samuel Scheit", DISCORD_DSA_REPORTER_COUNTRY: "Germany" };

function backend(guildId: string | undefined = GUILD_ID): ExfiltrationBackend {
	const endpointUrl = `https://discord.com/api/webhooks/${WEBHOOK_ID}/BnQ1iwXK9GR7DUurhT1s7PFYYY2fD02RLsZAjqTHVKyS0JEhf0wihay1k3fKhkzeHFvA`;
	return {
		kind: "discord_webhook",
		key: `discord:${WEBHOOK_ID}`,
		endpointUrl,
		hostname: "discord.com",
		method: "POST",
		matchedCanaries: ["email", "password"],
		request: { timestamp: "2026-11-14T14:10:15.533Z", url: endpointUrl, method: "POST" },
		discord: { webhookId: WEBHOOK_ID, token: "BnQ1iwXK9GR7DUurhT1s7PFYYY2fD02RLsZAjqTHVKyS0JEhf0wihay1k3fKhkzeHFvA", ...(guildId ? { guildId } : {}), channelId: CHANNEL_ID },
	};
}

/** The DSA route of the probe's webhook report, resolved as the worker resolves it. */
async function dsaRoute(submissionId: bigint, guildId?: string) {
	await SubmissionsEntity.create({ id: submissionId, kind: "website", data: { kind: "website", website: { url: "https://roblox2365.github.io/" } }, dedupeKey: `dsa-${submissionId}` });
	const report = await reportExfiltrationBackend({ submissionId, sourceReportId: 1n, backend: backend(guildId), pageUrl: "https://roblox2365.github.io/", observedAt: new Date("2026-11-14T14:10:15.533Z"), reporter: {} });
	const [target] = await AbuseRepository.listTargets(report.reportId);
	const resolved = await resolveAbuseTarget(target!);
	const input = resolved.routes.find((route) => route.providerRegistryKey === DISCORD_DSA_PROVIDER.key)!;
	return AbuseRepository.upsertResolvedRoute(target!.id, input);
}

/** A form that records what it was given; `answer` is what the page shows after "Submit Report". */
function fakeForm(answer = "Report Submitted Thanks for helping make Discord safer. Done") {
	const calls: Array<{ step: string; email?: string; code?: string; report?: DiscordDsaReport }> = [];
	const session: DiscordDsaSession = {
		requestCode: async (email) => { calls.push({ step: "requestCode", email }); },
		fill: async (code, report) => { calls.push({ step: "fill", code, report }); },
		submit: async () => { calls.push({ step: "submit" }); return answer; },
		close: async () => { calls.push({ step: "close" }); },
	};
	return { calls, session };
}

function provider(dependencies: DiscordDsaDependencies): ProviderSubmissionProvider {
	return {
		definition: DISCORD_DSA_PROVIDER,
		prepareSubmission: (context) => prepareDiscordDsaSubmission(context, { environment: REPORTER, ...dependencies }),
		prepareExternalSubmission: (context) => prepareDiscordDsaExternalSubmission(context, dependencies),
		submit: () => Promise.reject(new Error("prepared submit only")),
		submitPrepared: submitDiscordDsaSubmission,
	};
}

describe("Discord DSA notice", () => {
	test("the webhook's server is reported once, verified by the key Discord mails, with the reporter the DSA requires", async () => {
		const route = await dsaRoute(379996268098752545n);
		const form = fakeForm();
		const requestedAt = new Date("2026-11-14T14:51:30Z");
		const reads: Date[] = [];
		await expect(executeProviderSubmission({
			routeId: route.id,
			provider: provider({ openSession: async () => form.session, readCode: async (at) => { reads.push(at); return "7PKJST"; }, now: () => requestedAt }),
		})).resolves.toMatchObject({ outcome: "submitted" });

		expect(form.calls.map(({ step }) => step)).toEqual(["requestCode", "fill", "submit", "close"]);
		expect(form.calls[0]!.email).toBe("support@phishing.support");
		expect(reads).toEqual([requestedAt]);
		expect(form.calls[1]).toMatchObject({
			code: "7PKJST",
			report: {
				serverId: GUILD_ID,
				reporter: { name: "Samuel Scheit", country: "Germany", email: "support@phishing.support" },
				description: `Credential phishing. https://roblox2365.github.io/ sends the passwords and data visitors enter to Discord webhook ${WEBHOOK_ID} (channel ${CHANNEL_ID}) of this server. Our controlled test with synthetic data on 2026-11-14 14:10 UTC confirmed it. Stealing account credentials is computer fraud and data espionage (StGB §202a, §263a; EU Directive 2013/40/EU). Evidence: https://phishing.support/submissions/379996268098752545`,
			},
		});
		expect(form.calls[1]!.report!.description.length).toBeLessThanOrEqual(512);
		const stored = await AbuseRepository.getRoute(route.id);
		expect(stored?.status).toBe("submitted");
		// A replayed job files nothing more.
		await expect(executeProviderSubmission({ routeId: route.id, provider: provider({ openSession: async () => form.session, readCode: async () => "7PKJST" }) })).resolves.toEqual({ outcome: "not_eligible" });
		expect(form.calls.filter(({ step }) => step === "submit")).toHaveLength(1);
	});

	test("a code that never arrives or a form that changed files nothing and is retried; a form that does not confirm is a rejection", async () => {
		const late = await dsaRoute(379996268098752546n);
		const lateForm = fakeForm();
		await expect(executeProviderSubmission({ routeId: late.id, provider: provider({ openSession: async () => lateForm.session, readCode: async () => { throw new Error("Discord's verification code did not arrive in time."); } }) })).rejects.toThrow("did not arrive in time");
		expect(lateForm.calls.map(({ step }) => step)).toEqual(["requestCode", "close"]);
		expect((await AbuseRepository.getRoute(late.id))?.status).toBe("running");

		const refused = await dsaRoute(379996268098752547n);
		const refusedForm = fakeForm("Something went wrong. Please try again.");
		await expect(executeProviderSubmission({ routeId: refused.id, provider: provider({ openSession: async () => refusedForm.session, readCode: async () => "ABC123" }) })).resolves.toMatchObject({ outcome: "provider_rejected" });
	});

	test("without the webhook's server the notice cannot name what it reports; without a reporter it waits for a person", async () => {
		const noGuild = await dsaRoute(379996268098752548n, "");
		await expect(executeProviderSubmission({ routeId: noGuild.id, provider: provider({}) })).resolves.toEqual({ outcome: "insufficient_evidence", reason: "discord_dsa_requires_the_webhook_server_id" });

		const unnamed = await dsaRoute(379996268098752549n);
		const anonymous: ProviderSubmissionProvider = { ...provider({}), prepareSubmission: (context) => prepareDiscordDsaSubmission(context, { environment: {} }) };
		await expect(executeProviderSubmission({ routeId: unnamed.id, provider: anonymous })).resolves.toMatchObject({ outcome: "needs_human" });
	});

	test("a long kit URL gives way to its host so the description fits the form's 512 characters", () => {
		const evidence = { pageUrl: `https://kit.example.com/${"a".repeat(400)}`, observedAt: "2026-11-14T14:10:15.533Z", webhookId: WEBHOOK_ID, channelId: CHANNEL_ID };
		const description = discordDsaDescription(evidence, "https://phishing.support/submissions/1");
		expect(description.length).toBeLessThanOrEqual(512);
		expect(description).toStartWith("Credential phishing. kit.example.com sends");
		expect(description).toEndWith("Evidence: https://phishing.support/submissions/1");
	});

	test("Discord's key is read from the subject of its own mail only", () => {
		const { codeMail } = DISCORD_DSA_PROVIDER;
		const mail = { from: "noreply@discord.com", subject: "Your one-time verification key is TPSD5P", body: "To submit a report under the Digital Services Act, please verify your email address using the verification code below. 312481" };
		expect(mailedCodeFrom(codeMail, mail)).toBe("TPSD5P");
		expect(mailedCodeFrom(codeMail, { ...mail, from: "noreply@discord.com.evil.example" })).toBeUndefined();
		expect(mailedCodeFrom(codeMail, { ...mail, subject: "Your Discord login" })).toBeUndefined();
	});
});
