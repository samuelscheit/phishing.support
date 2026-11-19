import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { getDb } from "../../../db";
import { useTemporaryDatabase } from "../../../db/test_helpers";
import { validateAbuseReportRequest } from "../../contracts";
import { AbuseRepository } from "../../repository";
import { abuseJobs } from "../../schema";
import { pollProviderCorrespondence } from "../../worker/correspondence";

import { netcraftProvider } from ".";
import { netcraftMailProvider } from "../netcraft_mail";
import { fetchNetcraftCorrespondence, NETCRAFT_REVIEW_VERDICTS } from "./correspondence";
import { NETCRAFT_INBOUND_MAIL, netcraftNotificationVerdict } from "./inbound";

const UUID = "0123456789abcdef0123456789abcdef";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("Netcraft correspondence", () => {
	test("reads the submission's state alone, so a mail submission without URLs is read too", async () => {
		const requested: string[] = [];
		const result = await fetchNetcraftCorrespondence({ confirmationId: UUID }, {
			fetch: (async (url: string) => {
				requested.push(String(url));
				return json({ state: "Malicious", pending: false, has_urls: false, uuid: UUID });
			}) as never,
		});
		expect(result).toEqual({ messages: [], status: { state: "malicious" }, final: true });
		expect(requested).toEqual([`https://report.netcraft.com/api/v3/submission/${UUID}`]);
	});

	test("a submission still being analysed is read again", async () => {
		const result = await fetchNetcraftCorrespondence({ confirmationId: UUID }, { fetch: (async () => json({ state: "processing", pending: true, has_urls: true, uuid: UUID })) as never });
		expect(result).toEqual({ messages: [], status: { state: "processing" }, final: false });
	});

	test("a malformed or failed status read throws, so the poll is retried rather than recording nothing", async () => {
		await expect(fetchNetcraftCorrespondence({ confirmationId: UUID }, { fetch: (async () => json({ pending: false }, 200)) as never })).rejects.toThrow(/reviewed schema/);
		await expect(fetchNetcraftCorrespondence({ confirmationId: UUID }, { fetch: (async () => json({}, 503)) as never })).rejects.toThrow();
		await expect(fetchNetcraftCorrespondence({ confirmationId: "../../etc" })).rejects.toThrow(/invalid submission UUID/);
	});

	test("its verdicts: a threat is accepted, no threat is rejected, everything else is no decision yet", () => {
		expect(NETCRAFT_REVIEW_VERDICTS.malicious).toBe("acknowledged");
		expect(NETCRAFT_REVIEW_VERDICTS.suspicious).toBe("acknowledged");
		expect(NETCRAFT_REVIEW_VERDICTS["no threats"]).toBe("rejected");
		expect(NETCRAFT_REVIEW_VERDICTS.processing).toBeUndefined();
		expect(NETCRAFT_REVIEW_VERDICTS.unavailable).toBeUndefined();
	});

	test("its notification mails state their verdict; its receipt states none", () => {
		// Texts of production notifications, 2026-09 to 2026-11.
		expect(netcraftNotificationVerdict("We've analysed your submission! The submission you made to report.netcraft.com on 01-Nov-2026 at 05:57 UTC has been automatically analysed, and no threats were\nfound. The analysis was completed at 05:59 UTC.")).toBe("rejected");
		expect(netcraftNotificationVerdict("has been automatically analysed, and has been classified as malicious. The analysis was completed at 08:31 UTC.")).toBe("acknowledged");
		expect(netcraftNotificationVerdict("We've updated your submission! The submission you made ... has been reanalysed, and has been classified as malicious.")).toBe("acknowledged");
		expect(netcraftNotificationVerdict("Thanks for your report. We will analyse your submission shortly.")).toBeUndefined();
		expect(NETCRAFT_INBOUND_MAIL.verdictOf).toBe(netcraftNotificationVerdict);
	});

	test("both Netcraft channels are polled and share the verdicts", () => {
		for (const provider of [netcraftProvider, netcraftMailProvider]) {
			expect(provider.fetchCorrespondence).toBeFunction();
			expect(provider.reviewVerdicts).toBe(NETCRAFT_REVIEW_VERDICTS);
		}
	});
});

describe("Netcraft correspondence polling", () => {
	useTemporaryDatabase();
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	async function submittedNetcraftRoute() {
		const request = await validateAbuseReportRequest({ targets: ["netcraft-polled.com"], allegationCategory: "phishing", description: "Kit." });
		const report = await AbuseRepository.createReport({ request, reporter: {} });
		const [target] = await AbuseRepository.listTargets(report.reportId);
		const route = await AbuseRepository.upsertResolvedRoute(target!.id, {
			routeKey: "provider:netcraft", providerRegistryKey: "netcraft", providerDisplayName: "Netcraft",
			routeType: "provider_submission", resolverProvenance: { source: "test" }, resolutionSnapshot: { source: "test" }, status: "verified",
		});
		const run = await AbuseRepository.createProviderRun({ routeId: route.id, providerPayload: {}, correlationKey: `nc:${route.id.toString()}` });
		await AbuseRepository.settleProviderRun({ runId: run.id, executionStatus: "completed", routeStatus: "submitted", confirmationId: UUID, submittedTargets: ["netcraft-polled.com"] });
		return { reportId: report.reportId, route };
	}

	const polls = async (routeId: bigint) => (await getDb()).select().from(abuseJobs).where(eq(abuseJobs.routeId, routeId)).all().filter((job) => job.jobType === "poll_provider_correspondence" && job.status === "queued");

	test("records each verdict once and reads again only while Netcraft is still analysing", async () => {
		let body = { state: "processing", pending: true, has_urls: true, uuid: UUID };
		globalThis.fetch = (async () => json(body)) as typeof fetch;
		const { reportId, route } = await submittedNetcraftRoute();
		await pollProviderCorrespondence({ routeId: route.id, jobId: 1n });
		expect(await polls(route.id)).toHaveLength(1);

		body = { state: "No threats", pending: false, has_urls: true, uuid: UUID };
		const [next] = await polls(route.id);
		await pollProviderCorrespondence({ routeId: route.id, jobId: next!.id });
		const mail = (await AbuseRepository.listMailForReport(reportId)).filter((message) => message.routeId === route.id);
		expect(mail.map(({ subject, classification }) => [subject, classification])).toEqual([["Report status: processing", null], ["Report status: no threats", "rejected"]]);
		// The verdict is final: no further read is queued beyond the one that just ran.
		expect((await polls(route.id)).filter((job) => job.id !== next!.id)).toHaveLength(0);
	});
});
