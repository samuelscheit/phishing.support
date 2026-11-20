import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser } from "rebrowser-puppeteer-core";

import { useTemporaryDatabase } from "../../db/test_helpers";
import { browserTaskModel, type ChatModel } from "../../browser/task/agent";
import { chromiumAvailable, html, launchTestChromium, refIn, requestTexts, ScriptedModel, selfSignedCertificate, StalledModel, type ScriptedTurn } from "../../browser/task/test_helpers";
import { validateAbuseReportRequest } from "../contracts";
import { buildGenericProviderFormTask } from "../portal/form_task";
import { AbuseRepository } from "../repository";
import { runGenericProviderPortal } from "./portal";
import type { UnknownExternalStateParams, WorkerServices } from "./shared";

useTemporaryDatabase();

/**
 * The generic provider-form flow end to end: a durable route and run, the
 * task agent driven by a scripted model in a real Chromium, and a provider
 * abuse form served over HTTPS at its real-looking verified host.
 */
const DOMAIN = "example-provider.com";
const HOST = `report.${DOMAIN}`;
const TARGET = "example.com";
const OBSERVED_URL = "https://login.example.com/collect";

type Submission = Record<string, string>;
const submissions: Submission[] = [];
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

const FORM = `<h1>Report abuse</h1>
<form method="POST" action="/report">
	<label>Domain <input name="domain" required></label>
	<label>Category <select name="category"><option value="">Choose…</option><option value="phishing">Phishing</option><option value="spam">Spam</option></select></label>
	<label>Description <textarea name="description" required></textarea></label>
	<label>Your email <input type="email" name="email" required></label>
	<label><input type="checkbox" name="accurate" required> I confirm this report is accurate</label>
	<button type="submit">Submit report</button>
</form>`;

beforeAll(async () => {
	if (!chromiumAvailable) return;
	server = Bun.serve({
		port: 0,
		tls: selfSignedCertificate(HOST),
		fetch: async (request) => {
			const { pathname } = new URL(request.url);
			if (pathname === "/report" && request.method === "POST") {
				submissions.push(Object.fromEntries(new URLSearchParams(await request.text())));
				return new Response(null, { status: 303, headers: { location: "/confirmation" } });
			}
			if (pathname === "/confirmation") return html(`<h1>Thank you</h1><p>Your abuse report has been received. Case number PSR-4242.</p>`, "Report received");
			if (pathname === "/report-verified") return html(`<h1>Report abuse</h1><p>Enter the verification code we emailed to you before you can report.</p><label>Code <input name="code"></label><button>Continue</button>`);
			if (pathname === "/report") return html(FORM, "Report abuse");
			return new Response("not found", { status: 404 });
		},
	});
	browser = await launchTestChromium({ [HOST]: server.port! });
});
afterAll(async () => {
	await browser?.close();
	server?.stop(true);
});

async function portalRoute(entryPath = "/report", maxSteps = 6) {
	const request = await validateAbuseReportRequest({
		targets: [TARGET],
		allegationCategory: "phishing",
		description: "A credential-harvesting page impersonates the protected brand.",
		observedUrls: [{ target: TARGET, urls: [OBSERVED_URL] }],
	});
	const created = await AbuseRepository.createReport({ request, reporter: { reporterIp: "8.8.8.8" } });
	const [target] = await AbuseRepository.listTargets(created.reportId);
	if (!target) throw new Error("Test report did not create its target.");
	const route = await AbuseRepository.upsertResolvedRoute(target.id, {
		routeKey: `email:${DOMAIN}`,
		providerRegistryKey: `email:${DOMAIN}`,
		providerDisplayName: "Example Provider",
		routeType: "email",
		verifiedEmail: `abuse@${DOMAIN}`,
		resolverProvenance: { source: "portal_test" },
		resolutionSnapshot: { source: "test" },
		status: "queued",
	});
	expect(await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: "queued", to: "escalating_to_portal" })).toBeTrue();
	const entryUrl = `https://${HOST}${entryPath}`;
	const task = buildGenericProviderFormTask({
		entryUrl,
		allowedDomains: [DOMAIN],
		target: TARGET,
		allegationCategory: "phishing",
		description: "A credential-harvesting page impersonates the protected brand.",
		observedUrls: [OBSERVED_URL],
		reporter: { name: "Phishing Support", organization: "Phishing Support", website: "https://phishing.support", email: "support@phishing.support" },
		observedAt: new Date("2026-11-17T08:00:00Z"),
		maxSteps,
	});
	const execution = await AbuseRepository.beginProviderExecution({
		routeId: route.id,
		correlationKey: `generic-portal:${route.id.toString()}:test`,
		providerPayload: {
			adapter: "generic_verified_provider_form",
			entryUrl,
			verifiedDomains: [DOMAIN],
			task,
			contract: { entryUrl, target: TARGET, observedUrls: [OBSERVED_URL], allowedFinalDomains: [DOMAIN] },
		},
		expectedStatus: "escalating_to_portal",
	});
	if (!execution) throw new Error("Test portal route could not be claimed.");
	return { reportId: created.reportId, route, run: execution.run };
}

function services(model: ChatModel | (() => ChatModel), options: { signal?: AbortSignal } = {}) {
	const lease: string[] = [];
	const unknown: UnknownExternalStateParams[] = [];
	const worker: WorkerServices = {
		owner: "portal-test",
		...(options.signal ? { signal: options.signal } : {}),
		browserTaskModel: typeof model === "function" ? model : () => model,
		acquireBrowserSession: async (metadata, sessionOptions) => {
			lease.push(`acquire ${sessionOptions.egress} ${String(metadata.operation)} route=${String(metadata.routeId)}`);
			return {
				id: "browser-session_portal-test",
				cdpEndpoint: browser.wsEndpoint(),
				release: async () => { lease.push("release"); },
				cancel: async () => { lease.push("cancel"); },
			};
		},
		markUnknownExternal: async (params) => {
			unknown.push(params);
			await AbuseRepository.markUnknownExternalState(params);
		},
	};
	return { worker, lease, unknown };
}

/** The agent fills the form from the immutable payload in its goal, ticks the form's own consent, and submits. */
const fillAndSubmit: ScriptedTurn = (page, request) => {
	expect(requestTexts(request).join("\n")).toContain(`immutable report payload: {"target":"${TARGET}"`);
	return {
		text: "Fill the report form from the payload, then submit it.",
		calls: [
			{ name: "type", arguments: { ref: refIn(page, 'textbox "Domain"'), text: TARGET } },
			{ name: "select", arguments: { ref: refIn(page, 'combobox "Category'), value: "Phishing" } },
			{ name: "type", arguments: { ref: refIn(page, 'textbox "Description"'), text: `Phishing on ${TARGET}: ${OBSERVED_URL}` } },
			{ name: "type", arguments: { ref: refIn(page, 'textbox "Your email"'), text: "support@phishing.support" } },
			{ name: "click", arguments: { ref: refIn(page, 'checkbox "I confirm this report is accurate"') } },
			{ name: "click", arguments: { ref: refIn(page, 'button "Submit report"') } },
		],
	};
};

function finishWith(result: Record<string, unknown>): ScriptedTurn {
	return (page) => {
		expect(page).toContain("Case number PSR-4242");
		return { calls: [{ name: "done", arguments: { result, summary: "Submitted the report." } }] };
	};
}

const confirmed = {
	form_contract_passed: true,
	confirmation_text: "Your abuse report has been received. Case number PSR-4242.",
	confirmation_id: "PSR-4242",
	final_url: `https://${HOST}/confirmation`,
	submitted_domains: [TARGET],
	submitted_urls: [OBSERVED_URL],
	provider_errors: [],
	form_drift: false,
	final_submit_clicked: true,
	final_submit_control: "provider_report_submit",
	irreversible_actions: ["provider_report_submit"],
};

describe.skipIf(!chromiumAvailable)("the generic provider-form flow (real Chromium, scripted model)", () => {
	test("files the report through the form on a reporting-egress browser, settles the route as submitted, and keeps the task record", async () => {
		submissions.length = 0;
		const { reportId, route, run } = await portalRoute();
		const model = new ScriptedModel([fillAndSubmit, finishWith(confirmed)]);
		const { worker, lease, unknown } = services(model);

		await runGenericProviderPortal(route.id, {}, worker);

		expect(submissions).toEqual([{ domain: TARGET, category: "phishing", description: `Phishing on ${TARGET}: ${OBSERVED_URL}`, email: "support@phishing.support", accurate: "on" }]);
		expect(lease).toEqual([`acquire reporting provider-form route=${route.id.toString()}`, "release"]);
		expect(unknown).toEqual([]);
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "submitted" });
		const settled = await AbuseRepository.getProviderRun(run.id);
		expect(settled).toMatchObject({
			executionStatus: "completed",
			confirmationId: "PSR-4242",
			finalUrl: `https://${HOST}/confirmation`,
			submittedTargets: [TARGET],
			attemptCount: 1,
		});
		// The durable boundary kept the Fabric session that ran the task.
		expect(settled?.providerPayload.__fabricBrowserSessionId).toBe("browser-session_portal-test");
		const events = (await AbuseRepository.listEvents(reportId)).map((event) => event.eventType);
		expect(events.indexOf("provider_run.browser_task_started")).toBeLessThan(events.indexOf("provider_run.settled"));

		const [record] = await AbuseRepository.listRouteArtifacts(route.id, ["browser_task_record"]);
		expect(record).toMatchObject({ mimeType: "application/json", metadata: { status: "done", model: "test/scripted" } });
		const stored = JSON.parse(Buffer.from(record!.blob).toString("utf8"));
		expect(stored).toMatchObject({ status: "done", result: confirmed, finalUrl: `https://${HOST}/confirmation` });
		expect(stored.steps[0].actions.map((action: { tool: string; ok: boolean }) => `${action.tool}:${action.ok}`)).toEqual(["type:true", "select:true", "type:true", "type:true", "click:true", "click:true"]);
		// The model's prompt is not evidence; only the run's outcome and steps are stored.
		expect(JSON.stringify(stored)).not.toContain("Use only this immutable report payload");
	}, 60_000);

	test("a form that only sends after a verification code goes to a person, without submitting", async () => {
		submissions.length = 0;
		const { route, run } = await portalRoute("/report-verified");
		const model = new ScriptedModel([
			(page) => {
				expect(page).toContain("Enter the verification code");
				return { calls: [{ name: "needs_input", arguments: { question: "The form requires the verification code emailed to the reporter." } }] };
			},
		]);
		const { worker, lease } = services(model);
		await runGenericProviderPortal(route.id, {}, worker);
		expect(submissions).toEqual([]);
		expect(lease.at(-1)).toBe("release");
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "needs_human" });
		expect(await AbuseRepository.getProviderRun(run.id)).toMatchObject({
			executionStatus: "failed",
			failureReason: "The agent needs input: The form requires the verification code emailed to the reporter.",
		});
	}, 60_000);

	test("a submission whose result breaks the immutable contract goes to a person with the contract's reason", async () => {
		const { route, run } = await portalRoute();
		const model = new ScriptedModel([fillAndSubmit, finishWith({ ...confirmed, submitted_urls: ["https://login.example.com/other"] })]);
		await runGenericProviderPortal(route.id, {}, services(model).worker);
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "needs_human" });
		expect(await AbuseRepository.getProviderRun(run.id)).toMatchObject({ executionStatus: "completed", failureReason: "submitted_target_contract_mismatch", confirmationId: null });
	}, 60_000);

	test("form drift stops without submitting and goes to a person with the agent's reason", async () => {
		submissions.length = 0;
		const { route, run } = await portalRoute();
		const drift = {
			form_contract_passed: false,
			confirmation_text: "",
			final_url: `https://${HOST}/report`,
			submitted_domains: [],
			submitted_urls: [],
			provider_errors: [],
			form_drift: true,
			form_drift_reason: "The form has no field for the reported domain.",
			final_submit_clicked: false,
			final_submit_control: "none",
			irreversible_actions: [],
		};
		const model = new ScriptedModel([() => ({ calls: [{ name: "done", arguments: { result: drift, summary: "Form drift." } }] })]);
		await runGenericProviderPortal(route.id, {}, services(model).worker);
		expect(submissions).toEqual([]);
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "needs_human" });
		expect(await AbuseRepository.getProviderRun(run.id)).toMatchObject({ failureReason: "The form has no field for the reported domain." });
	}, 60_000);

	test("a result that breaks the schema is sent back to the model, which must correct it before it is accepted", async () => {
		const { route } = await portalRoute();
		const model = new ScriptedModel([
			fillAndSubmit,
			() => ({ calls: [{ name: "done", arguments: { result: { ...confirmed, attacker_selected_url: "https://evil.example" }, summary: "x" } }] }),
			(page, request) => {
				expect(requestTexts(request).join("\n")).toContain("the result does not match the schema: result.attacker_selected_url: not allowed");
				return finishWith(confirmed)(page, request);
			},
		]);
		await runGenericProviderPortal(route.id, {}, services(model).worker);
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "submitted" });
	}, 60_000);

	test("an agent that gives up, or runs out of steps, fails the route", async () => {
		const gaveUp = await portalRoute();
		await runGenericProviderPortal(gaveUp.route.id, {}, services(new ScriptedModel([() => ({ calls: [{ name: "fail", arguments: { reason: "The form rejects every submission with a server error." } }] })])).worker);
		expect(await AbuseRepository.getRoute(gaveUp.route.id)).toMatchObject({ status: "failed" });
		expect(await AbuseRepository.getProviderRun(gaveUp.run.id)).toMatchObject({ executionStatus: "failed", failureReason: "failed: The form rejects every submission with a server error." });

		const looping = await portalRoute();
		const scroll: ScriptedTurn = () => ({ calls: [{ name: "scroll", arguments: { direction: "down" } }] });
		await runGenericProviderPortal(looping.route.id, {}, services(new ScriptedModel(Array.from({ length: 6 }, () => scroll))).worker);
		expect(await AbuseRepository.getRoute(looping.route.id)).toMatchObject({ status: "failed" });
		expect((await AbuseRepository.getProviderRun(looping.run.id))?.failureReason).toStartWith("step_limit: Stopped after 6 steps");
	}, 60_000);

	test("a run found already started is never run again: the route is fenced as unknown and its browser cancelled", async () => {
		const { route, run } = await portalRoute();
		expect(await AbuseRepository.startBrowserTask({ runId: run.id, fabricSessionId: "browser-session_crashed" })).toBeTrue();
		// A second start of the same run is refused.
		expect(await AbuseRepository.startBrowserTask({ runId: run.id, fabricSessionId: "browser-session_other" })).toBeFalse();
		const model = new ScriptedModel([]);
		const { worker, lease, unknown } = services(model);
		await expect(runGenericProviderPortal(route.id, {}, worker)).rejects.toThrow("interrupted after it started");
		expect(lease).toEqual([]);
		expect(model.requests).toEqual([]);
		expect(unknown).toMatchObject([{ routeId: route.id, runId: run.id, reason: "browser_task_interrupted" }]);
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "unknown_external_state" });
		expect((await AbuseRepository.getProviderRun(run.id))?.providerPayload.__fabricBrowserSessionId).toBe("browser-session_crashed");
	}, 60_000);

	// A real model files the report: PHISHING_TASK_LIVE=1 with the app's model configuration (OPENAI_MODEL, OPENAI_API_KEY, …).
	test.skipIf(process.env.PHISHING_TASK_LIVE !== "1")("a real model files the report through the fixture form", async () => {
		submissions.length = 0;
		const { route, run } = await portalRoute("/report", 15);
		const model = browserTaskModel();
		const { worker, lease } = services(model);
		await runGenericProviderPortal(route.id, {}, worker);
		const settled = await AbuseRepository.getProviderRun(run.id);
		const [record] = await AbuseRepository.listRouteArtifacts(route.id, ["browser_task_record"]);
		const stored = JSON.parse(Buffer.from(record!.blob).toString("utf8"));
		console.log(`live model ${model.id}: ${stored.status} in ${stored.steps.length} steps, ${stored.usage.inputTokens}+${stored.usage.outputTokens} tokens; route ${(await AbuseRepository.getRoute(route.id))?.status}; ${settled?.failureReason ?? "no failure"}`);
		console.log(JSON.stringify(submissions));
		expect(submissions).toHaveLength(1);
		expect(submissions[0]).toMatchObject({ domain: TARGET, category: "phishing", email: "support@phishing.support", accurate: "on" });
		expect(submissions[0]!.description).toContain(OBSERVED_URL);
		expect(lease.at(-1)).toBe("release");
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "submitted" });
		expect(settled).toMatchObject({ executionStatus: "completed", finalUrl: `https://${HOST}/confirmation`, submittedTargets: [TARGET] });
	}, 300_000);

	test("a missing model is an ordinary retryable failure before any marker or browser", async () => {
		const { route, run } = await portalRoute();
		const { worker, lease } = services(() => { throw new Error("OPENAI_API_KEY is required for the browser task model."); });
		await expect(runGenericProviderPortal(route.id, {}, worker)).rejects.toThrow("OPENAI_API_KEY");
		expect(lease).toEqual([]);
		expect(await AbuseRepository.getProviderRun(run.id)).toMatchObject({ executionStatus: "starting" });
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "running" });
	}, 60_000);

	test("an aborted job stops the agent, cancels its browser and leaves the started run for the worker to fence", async () => {
		const { route, run } = await portalRoute();
		const controller = new AbortController();
		const { worker, lease } = services(new StalledModel(), { signal: controller.signal });
		const running = runGenericProviderPortal(route.id, {}, worker);
		await Bun.sleep(1_500);
		controller.abort(new Error("Abuse worker is stopping."));
		await expect(running).rejects.toThrow("Abuse worker is stopping.");
		expect(lease.at(-1)).toBe("cancel");
		expect(await AbuseRepository.getProviderRun(run.id)).toMatchObject({ executionStatus: "task_started" });
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "running" });
	}, 60_000);
});
