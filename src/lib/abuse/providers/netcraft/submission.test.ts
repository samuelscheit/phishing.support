import { describe, expect, test } from "bun:test";

import { useTemporaryDatabase } from "../../../db/test_helpers";
import { validateAbuseReportRequest } from "../../contracts";
import { AbuseRepository } from "../../repository";
import { ProviderSubmissionRejectedError } from "../submission_contracts";
import { executeProviderSubmission } from "../submission_execution";
import type { ProviderSubmissionProvider } from "../submission_contracts";
import { NETCRAFT_PROVIDER } from "./definition";
import { buildNetcraftSubmissionPayload } from "./payload";
import {
	netcraftSubmissionUrl,
	parseNetcraftSubmissionResponse,
	prepareNetcraftSubmission,
	submitNetcraftSubmission,
} from "./submission";

useTemporaryDatabase();

function payload() {
	const result = buildNetcraftSubmissionPayload({
		target: "phishing.example.com",
		observedUrls: ["https://login.phishing.example.com/collect"],
		description: "The page harvests credentials.",
		reporterEmail: "reports@phishing.support",
	});
	if (!result) throw new Error("Expected a Netcraft payload.");
	return result;
}

describe("Netcraft v3 submission response", () => {
	test("retains the provider UUID and status endpoint after explicit acceptance", async () => {
		await expect(parseNetcraftSubmissionResponse(
			new Response(JSON.stringify({ message: "Successfully reported", uuid: "AaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa" })),
			payload(),
		)).resolves.toEqual({
			confirmationId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			confirmationText: "Successfully reported",
			finalUrl: "https://report.netcraft.com/api/v3/submission/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			submittedTargets: ["phishing.example.com"],
		});
	});

	test("treats only explicit client-side API rejections as known outcomes", async () => {
		await expect(parseNetcraftSubmissionResponse(
			new Response(JSON.stringify({ error: "Invalid URLs" }), { status: 400 }),
			payload(),
		)).rejects.toBeInstanceOf(ProviderSubmissionRejectedError);
		await expect(parseNetcraftSubmissionResponse(
			new Response("Too many URLs", { status: 429 }),
			payload(),
		)).rejects.toBeInstanceOf(ProviderSubmissionRejectedError);
	});

	test("fails closed for malformed success evidence and upstream failures", async () => {
		await expect(parseNetcraftSubmissionResponse(
			new Response("not json"),
			payload(),
		)).rejects.toThrow("valid JSON confirmation");
		await expect(parseNetcraftSubmissionResponse(
			new Response(JSON.stringify({ message: "Accepted" })),
			payload(),
		)).rejects.toThrow("valid submission UUID");
		await expect(parseNetcraftSubmissionResponse(
			new Response("upstream unavailable", { status: 502 }),
			payload(),
		)).rejects.toThrow("submission failed with HTTP 502");
	});

	test("constructs a fixed API status URL only from an exact Netcraft identifier", () => {
		expect(netcraftSubmissionUrl("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(
			"https://report.netcraft.com/api/v3/submission/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		);
		expect(() => netcraftSubmissionUrl("https://attacker.example/")).toThrow("invalid submission UUID");
	});

	test("executes one durable API submission with every observed URL", async () => {
		const previousReporterEmail = process.env.ABUSE_NETCRAFT_REPORTER_EMAIL;
		process.env.ABUSE_NETCRAFT_REPORTER_EMAIL = "netcraft-test@phishing.support";
		try {
			const request = await validateAbuseReportRequest({
				targets: ["phishing.example.com"],
				allegationCategory: "phishing",
				description: "The URLs host credential-harvesting pages.",
				observedUrls: [{
					target: "phishing.example.com",
					urls: [
						"https://login.phishing.example.com/collect",
						"https://phishing.example.com/alternate",
					],
				}],
			});
			const created = await AbuseRepository.createReport({ request, reporter: { reporterIp: "8.8.8.8" } });
			const [target] = await AbuseRepository.listTargets(created.reportId);
			if (!target) throw new Error("Expected a report target.");
			const route = await AbuseRepository.upsertResolvedRoute(target.id, {
				routeKey: "provider_submission:netcraft:supplemental",
				providerRegistryKey: NETCRAFT_PROVIDER.key,
				providerDisplayName: NETCRAFT_PROVIDER.displayName,
				routeType: "provider_submission",
				providerDefinitionVersion: NETCRAFT_PROVIDER.version,
				providerDefinitionHash: NETCRAFT_PROVIDER.contentHash,
				resolverProvenance: { source: "netcraft_submission_test" },
				resolutionSnapshot: { source: "netcraft_submission_test" },
				status: "verified",
			});

			let requestUrl: string | undefined;
			let requestBody: Record<string, unknown> | undefined;
			let requestInit: RequestInit | undefined;
			const provider: ProviderSubmissionProvider = {
				definition: NETCRAFT_PROVIDER,
				prepareSubmission: prepareNetcraftSubmission,
				submit: async (context) => submitNetcraftSubmission(context, {
					fetch: async (input, init) => {
						requestUrl = String(input);
						requestInit = init;
						requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
						expect(await AbuseRepository.getProviderRun(context.runId!)).toMatchObject({
							executionStatus: "submission_started",
						});
						return new Response(JSON.stringify({
							message: "Successfully reported",
							uuid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
						}));
					},
				}),
			};

			await expect(executeProviderSubmission({ routeId: route.id, provider })).resolves.toEqual({
				outcome: "submitted",
				runId: expect.any(BigInt),
			});
			expect(requestUrl).toBe(NETCRAFT_PROVIDER.reportUrlsUrl);
			expect(requestInit?.method).toBe("POST");
			expect(requestInit?.redirect).toBe("error");
			expect(new Headers(requestInit?.headers).get("content-type")).toBe("application/json");
			expect(new Headers(requestInit?.headers).get("accept")).toBe("application/json");
			expect(requestBody).toEqual({
				email: "netcraft-test@phishing.support",
				reason: "The URLs host credential-harvesting pages.",
				urls: [
					{ url: "https://login.phishing.example.com/collect" },
					{ url: "https://phishing.example.com/alternate" },
				],
			});
			const [run] = await AbuseRepository.listProviderRunsForReport(created.reportId);
			expect(run).toMatchObject({
				executionStatus: "completed",
				confirmationId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
				finalUrl: "https://report.netcraft.com/api/v3/submission/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
				submittedTargets: ["phishing.example.com"],
			});
		} finally {
			if (previousReporterEmail === undefined) delete process.env.ABUSE_NETCRAFT_REPORTER_EMAIL;
			else process.env.ABUSE_NETCRAFT_REPORTER_EMAIL = previousReporterEmail;
		}
	});
});
