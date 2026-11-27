import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { getDb } from "../db";
import { ArtifactsEntity } from "../db/entities/artifacts";
import { SubmissionsEntity } from "../db/entities/submissions";
import { useTemporaryDatabase } from "../db/test_helpers";
import { validateAbuseReportRequest } from "../abuse/contracts";
import { sendAbuseEmailRoute } from "../abuse/mail/send";
import { abuseCaseTag } from "../abuse/mail/correlation";
import { AbuseRepository } from "../abuse/repository";
import { jobs } from "../abuse/schema";
import { sendEmail } from "../abuse/worker/email";
import { classifyReply } from "../abuse/worker/mail";
import type { CampaignMember } from "../campaign/members";
import { CampaignRepository } from "../campaign/repository";
import type { ExtractedIndicator } from "../campaign/indicators";
import { ingestFetchedMail } from "../imap/ingest";
import { approveDraftedMail, discardDraftedMail, OperatorActionError, saveDraftedMail } from "../abuse/approval/drafted_mail";
import { preparePreservationNotices, prepareComplaint, prepareSupplement, ReferralError, setReferralCaseReference, type ReferralDependencies } from "./service";
import { getCampaignOverview } from "./overview";
import { buildDossier } from "./dossier";
import { factsFromDossier } from "../campaign/link";
import { describeIndicatorEnglish } from "./archive_text";
import { describeIndicator } from "./render";
import { getPublicCampaign } from "../campaign/public_view";
import { listSubmissionCards } from "../submissions/list";
import { groupByCampaign } from "../submissions/campaign_groups";

useTemporaryDatabase();

const environmentNames = ["SMTP_FROM", "REPLY_DOMAIN", "OPENAI_API_KEY"] as const;
const originalEnvironment = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));

beforeEach(() => {
	process.env.SMTP_FROM = "support@phishing.support";
	process.env.REPLY_DOMAIN = "phishing.support";
	// A reply's classification must not depend on a model; the file number is read without one.
	delete process.env.OPENAI_API_KEY;
});

afterAll(() => {
	for (const name of environmentNames) {
		const value = originalEnvironment[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

const dependencies: ReferralDependencies = {
	complainant: () => ({ name: "Samuel Scheit", addressLines: ["Musterstraße 1", "85609 Aschheim"] }),
};

/** The secret half of a bot token, as long as real ones are. */
const TOKEN_SECRET = "AAEsecretSecretSecretSecretSecret0123";
const telegram = (botId: string): ExtractedIndicator => ({
	kind: "operator_server",
	value: `telegram-bot:${botId}`,
	links: true,
	evidence: { roles: ["receives_data"], backendKind: "telegram_bot", endpointUrl: `https://api.telegram.org/bot${botId}:${TOKEN_SECRET}/sendMessage`, method: "POST", observedAt: "2026-11-10T08:00:00.000Z", matchedFields: ["email", "password"], telegram: { token: `${botId}:${TOKEN_SECRET}`, botId, username: "dhl_paket_bot", chatId: "-100200300" } },
});
const kit = (sha: string): ExtractedIndicator => ({ kind: "kit_fingerprint", value: sha, links: true, evidence: { fileKind: "script", url: "https://kit.example/app.js", size: 18_000 } });

/** The member each reported case is for its one site. */
const members = new Map<bigint, CampaignMember>();
const memberOf = (id: bigint) => members.get(id)!;

/** A confirmed site with its takedown report, mailed to `abuseMailbox` when given. */
async function reportedSite(id: bigint, host: string, abuseMailbox?: string) {
	await SubmissionsEntity.create({
		id,
		kind: "website",
		data: { kind: "website", website: { url: `https://${host}/login`, whois: { ip_rdaps: [], rdap: { domain: host, status: [], nameservers: [], events: { registration: "2026-11-01T00:00:00Z" }, registrar: { remarks: "", roles: ["registrar"], links: [], publicIds: [], vcard: { fn: "Example Registrar Ltd" }, abuse: null } } } } },
		dedupeKey: `website-${host}`,
		status: "reported",
	});
	const request = await validateAbuseReportRequest({
		targets: [host],
		allegationCategory: "phishing",
		description: "A credential-harvesting page impersonates DHL.",
		observedUrls: [{ target: host, urls: [`https://${host}/login`] }],
		legalBrandUrl: "https://www.dhl.de/",
	});
	const report = await AbuseRepository.createReport({ request, reporter: {}, submissionId: id });
	members.set(id, { submissionId: id, reportId: report.reportId });
	if (!abuseMailbox) return;
	const [target] = await AbuseRepository.listTargets(report.reportId);
	const route = await AbuseRepository.upsertResolvedRoute(target!.id, {
		routeKey: `email:${abuseMailbox}`,
		providerRegistryKey: `email:${abuseMailbox.split("@")[1]}`,
		providerDisplayName: "Hostinger International Ltd.",
		routeType: "email",
		verifiedEmail: abuseMailbox,
		resolverProvenance: { source: "test" },
		resolutionSnapshot: {},
		status: "verified",
	});
	const delivery = await AbuseRepository.beginEmailDelivery({ routeId: route.id, providerPayload: { source: "test" }, correlationKey: `test-mail:${route.id.toString()}` });
	await sendAbuseEmailRoute({
		reportId: report.reportId,
		routeId: route.id,
		runId: delivery!.run.id,
		recipient: abuseMailbox,
		subject: `[Phishing Support] [${abuseCaseTag(report.reportId)}] Abuse report for ${host}`,
		body: "Takedown report.",
		correlationKey: delivery!.run.correlationKey,
		transport: { sendMail: async () => ({ messageId: "smtp-test" }) },
	});
	await AbuseRepository.settleEmailDelivery({ runId: delivery!.run.id, expectedRunStatus: "starting", expectedRouteStatus: "running", outcome: "sent" });
}

async function campaignOf(submissionId: bigint): Promise<bigint> {
	const campaignId = await CampaignRepository.campaignForMember(memberOf(submissionId));
	if (campaignId === undefined) throw new Error("The site has no campaign.");
	return campaignId;
}

async function sendJobs(routeId: bigint) {
	const db = await getDb();
	return db.select().from(jobs).where(and(eq(jobs.routeId, routeId), eq(jobs.jobType, "send_email"))).all();
}

/** Run the approved mail through the real worker and MIME boundary; return what went over SMTP. */
async function deliver(routeId: bigint): Promise<string> {
	let raw = "";
	await sendEmail(routeId, {
		markUnknownExternal: async (params) => { throw new Error(params.error); },
		send: (params) => sendAbuseEmailRoute({ ...params, transport: { sendMail: async (message) => { raw = message.raw.toString("utf8"); return { messageId: "smtp-referral" }; } } }),
	});
	return raw;
}

async function campaignWithThreeSites() {
	await reportedSite(11n, "dhl-paket-zustellung.com", "abuse@hostinger.example");
	await reportedSite(12n, "dhl-sendung-pruefen.net", "abuse@hostinger.example");
	await reportedSite(13n, "paket-dhl-info.org");
	await CampaignRepository.recordIndicators(memberOf(11n), [telegram("7001")]);
	await CampaignRepository.recordIndicators(memberOf(12n), [telegram("7001"), kit("a".repeat(64))]);
	await CampaignRepository.recordIndicators(memberOf(13n), [kit("a".repeat(64))]);
	return campaignOf(11n);
}

describe("criminal referral of a campaign", () => {
	test("drafts the complaint for approval and sends nothing", async () => {
		const campaignId = await campaignWithThreeSites();
		expect(await campaignOf(13n)).toBe(campaignId);
		const route = await prepareComplaint(campaignId, "by-zcb", dependencies);

		expect(route.status).toBe("awaiting_approval");
		expect(route.verifiedEmail).toBe("cybercrime@gensta-ba.bayern.de");
		expect(await sendJobs(route.id)).toEqual([]);
		expect((await AbuseRepository.getReport(route.reportId))?.status).toBe("needs_human");

		const draft = route.resolutionSnapshot.approvalDraft as { subject: string; body: string; allowedUrls: string[] };
		expect(draft.subject).toBe(`Strafanzeige gegen Unbekannt – Phishing-Kampagne mit 3 Websites (www.dhl.de) [${abuseCaseTag(route.reportId)}]`);
		for (const expected of [
			"hiermit erstatten wir für phishing.support Strafanzeige gegen Unbekannt",
			"Anzeigeerstatter und Ansprechpartner ist der Unterzeichnende.",
			"§ 263a Abs. 1 und 3 StGB",
			"https://dhl-paket-zustellung.com/login",
			"https://dhl-sendung-pruefen.net/login",
			"https://paket-dhl-info.org/login",
			"Telegram-Bot 7001 (@dhl_paket_bot) empfängt die Eingaben der Besucher (2 Seiten), Ziel-Chat-ID -100200300; Bot-Token 7001:AAEsecret",
			`Identische Kit-Datei (Skript, 18000 Byte, SHA-256 ${"a".repeat(64)}) (2 Seiten).`,
			"Besucher sollen dort E-Mail-Adresse, Passwort eingeben.",
			"Zypern (CY):\n  EU-Staat: Europäische Herausgabeanordnung (VO (EU) 2023/1543) direkt an den Anbieter.",
			"  - Anbieter: Hostinger International Ltd, Larnaka (Vertragspartner für Kunden in der EU) – Infrastruktur und Betrieb in Litauen",
			"Vereinigte Arabische Emirate (AE):",
			"  - Server der Betreiber (empfängt Eingaben oder liefert Schadsoftware): Telegram FZ-LLC – Gibt seit 09/2024",
			"Registrar Example Registrar Ltd",
			`https://phishing.support/campaigns/${campaignId.toString()}/evidence.zip`,
			`Eine laufend aktualisierte Übersicht aller Websites der Kampagne mit dem Stand der Sperrungen: https://phishing.support/campaigns/${campaignId.toString()}`,
			"Samuel Scheit\nphishing.support\nMusterstraße 1\n85609 Aschheim",
		]) expect(draft.body).toContain(expected);
		expect(draft.allowedUrls).toContain("https://paket-dhl-info.org/login");

		const attachments = await AbuseRepository.listRouteArtifacts(route.id, ["referral_attachment"]);
		expect(attachments.map((artifact) => artifact.name)).toEqual(["sites.csv", "indicators.csv"]);
		const sites = Buffer.from(attachments[0]!.blob).toString("utf8");
		expect(sites.startsWith("No,URL,Host,")).toBe(true);
		expect(sites.split("\r\n").filter(Boolean)).toHaveLength(4);

		await expect(prepareComplaint(campaignId, "by-zcb", dependencies)).rejects.toThrow(ReferralError);
		await expect(prepareSupplement(campaignId, "by-zcb", dependencies)).rejects.toThrow("No complaint");
	});

	test("the public campaign page shows the sites, why they belong together and the full technical record, as the operators published it", async () => {
		const campaignId = await campaignWithThreeSites();
		await reportedSite(15n, "dhl-iban-zahlung.com");
		const iban: ExtractedIndicator = { kind: "payment_receiver", value: "iban:DE89370400440532013000", links: true, evidence: { receiverKind: "iban", receiver: "DE89370400440532013000" } };
		const wallet: ExtractedIndicator = { kind: "payment_receiver", value: "tron:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", links: true, evidence: { receiverKind: "tron", receiver: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" } };
		await CampaignRepository.recordIndicators(memberOf(15n), [telegram("7001"), iban, wallet]);
		await CampaignRepository.recordIndicators(memberOf(13n), [kit("a".repeat(64)), iban, wallet]);
		await CampaignRepository.saveSiteFacts(memberOf(11n), { language: "de", thumbnailArtifactId: 4242n, blankCapture: false });
		// The visit's pages, saved out of order: the landing page, then the form after it, with its stamped copy.
		const shot = async (name: string, kind: string) => (await ArtifactsEntity.saveBuffer({ submissionId: 11n, name, kind, mimeType: "image/png", buffer: Buffer.from(name) })).toString();
		const form = await shot("website-step2.png", "website_png");
		const formStamped = await shot("website-step2-stamped.png", "website_evidence");
		const landing = await shot("website.png", "website_png");
		const campaign = (await getPublicCampaign(campaignId))!;
		expect(campaign.sites[0]!.steps).toEqual([
			{ step: 1, screenshotUrl: `/api/artifacts/${landing}` },
			{ step: 2, screenshotUrl: `/api/artifacts/${form}`, stampedUrl: `/api/artifacts/${formStamped}` },
		]);
		expect(campaign.sites[1]!.steps).toEqual([]);

		// Without a written heading, the fixed wording describes the campaign.
		expect(campaign.title).toBe("Phishing campaign impersonating www.dhl.de");
		expect(campaign.sites.map((site) => site.url)).toEqual([
			"https://dhl-paket-zustellung.com/login",
			"https://dhl-sendung-pruefen.net/login",
			"https://paket-dhl-info.org/login",
			"https://dhl-iban-zahlung.com/login",
		]);
		expect(campaign.sites[0]).toMatchObject({ language: "de", thumbnailUrl: "/api/artifacts/4242", takedown: "reported", reports: [{ bucket: "waiting", label: "Awaiting reply", channel: "email" }] });
		expect(campaign.sites[2]).toMatchObject({ takedown: "none", reports: [] });
		expect(campaign).toMatchObject({ domainCount: 4 });
		expect(campaign.platform).toBeUndefined();

		// The record: the bot with its token as the kit published it, the accounts in full, the kit file and the abuse contacts.
		expect(campaign.technical.backends).toEqual([{ kind: "telegram_bot", label: "Telegram bot", siteCount: 3, details: [
			["Bot ID", "7001"], ["Bot username", "@dhl_paket_bot"], ["Chat ID", "-100200300"], ["Token", `7001:${TOKEN_SECRET}`], ["Endpoint", `https://api.telegram.org/bot7001:${TOKEN_SECRET}/sendMessage`],
		] }]);
		expect(campaign.technical.payments).toEqual([{ kind: "iban", value: "DE89370400440532013000", siteCount: 2 }, { kind: "tron", value: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", siteCount: 2 }]);
		expect(campaign.technical.kitFiles).toEqual([{ sha256: "a".repeat(64), size: 18_000, path: "/app.js", siteCount: 2 }]);
		expect(campaign.technical.abuseContacts).toEqual(["abuse@hostinger.example"]);
		expect(await getPublicCampaign(999n)).toBeUndefined();
	});

	test("sites on one platform name it as theirs", async () => {
		for (const [index, name] of ["policy-a", "policy-b", "policy-c"].entries()) {
			const id = BigInt(21 + index);
			await reportedSite(id, `${name}.onrender.com`);
			await CampaignRepository.recordIndicators(memberOf(id), [kit("b".repeat(64))]);
		}
		const campaign = (await getPublicCampaign((await CampaignRepository.campaignForMember(memberOf(21n)))!))!;
		expect(campaign).toMatchObject({ platform: "onrender.com", domainCount: 1 });
	});

	test("sites that serve one page body are named as the same page, and the record and referral texts say what was compared", async () => {
		const body = "c".repeat(64);
		const page = (host: string): ExtractedIndicator => ({ kind: "kit_fingerprint", value: body, links: true, evidence: { fileKind: "page_document", url: `https://${host}/`, size: 27_657 } });
		for (const [index, host] of ["napxu.saobangmedia.shop", "napxu.trungdungmedia.sbs", "shopxu.thuysimedia.online"].entries()) {
			const id = BigInt(31 + index);
			await reportedSite(id, host);
			await CampaignRepository.recordIndicators(memberOf(id), [page(host)]);
		}
		const campaignId = (await CampaignRepository.campaignForMember(memberOf(31n)))!;
		const campaign = (await getPublicCampaign(campaignId))!;
		expect(campaign.sites).toHaveLength(3);
		expect(campaign.technical.kitFiles).toEqual([{ sha256: body, size: 27_657, path: "the page body (own address masked)", siteCount: 3 }]);

		const indicator = (await buildDossier(campaignId)).indicators.find((entry) => entry.value === body)!;
		expect(describeIndicatorEnglish(indicator)).toStartWith(`Identical page body (HTML, 27657 bytes; the page's own address masked; SHA-256 ${body})`);
		expect(describeIndicator(indicator)).toStartWith(`Identischer Seiteninhalt (HTML-Body, 27657 Byte; die eigene Adresse der Seite ausgeblendet; SHA-256 ${body})`);
		// The heading says they show the same page, not that they run the same code.
		expect(factsFromDossier(await buildDossier(campaignId), []).links).toEqual(["same_page"]);
	});

	test("sites whose malware comes from one server are named as such, and the referral texts name the server", async () => {
		const server: ExtractedIndicator = { kind: "operator_server", value: "host:keychainagent.pro", links: true, evidence: { roles: ["delivers_malware"], delivered: { url: "https://keychainagent.pro/wksxgj/wZZLR9xY29o4", sha256: "e".repeat(64), via: "pasted_command" } } };
		for (const [index, host] of ["paneo.work", "macmorrow.app"].entries()) {
			await reportedSite(BigInt(51 + index), host);
			await CampaignRepository.recordIndicators(memberOf(BigInt(51 + index)), [server]);
		}
		const campaignId = (await CampaignRepository.campaignForMember(memberOf(51n)))!;
		const dossier = await buildDossier(campaignId);
		const indicator = dossier.indicators.find((entry) => entry.kind === "operator_server")!;
		expect(describeIndicatorEnglish(indicator)).toBe(`Server keychainagent.pro delivers the malware visitors are made to run, e.g. https://keychainagent.pro/wksxgj/wZZLR9xY29o4 (SHA-256 ${"e".repeat(64)}) (2 sites).`);
		expect(describeIndicator(indicator)).toBe(`Server keychainagent.pro liefert die Schadsoftware, die Besucher ausführen sollen, z. B. https://keychainagent.pro/wksxgj/wZZLR9xY29o4 (SHA-256 ${"e".repeat(64)}) (2 Seiten).`);
		expect(factsFromDossier(dossier, []).links).toEqual(["same_backend"]);
	});

	test("pages built from one template are recorded as such, with an identical body among them", async () => {
		const template = "d".repeat(64);
		const body = "e".repeat(64);
		const hosts = ["dua.windswise.com", "lima.eliteedgemodeling.com", "tujuh.vilapoucajapan.com", "sembilan.lgswm.com"];
		for (const [index, host] of hosts.entries()) {
			const id = BigInt(41 + index);
			await reportedSite(id, host);
			await CampaignRepository.recordIndicators(memberOf(id), [
				{ kind: "kit_fingerprint", value: template, links: true, evidence: { fileKind: "page_structure", url: `https://${host}/894655`, size: 7_355, tags: 66 } },
				...(index < 2 ? [{ kind: "kit_fingerprint" as const, value: body, links: true, evidence: { fileKind: "page_document", url: `https://${host}/894655`, size: 7_355 } }] : []),
			]);
		}
		const campaignId = (await CampaignRepository.campaignForMember(memberOf(41n)))!;
		const campaign = (await getPublicCampaign(campaignId))!;
		expect(campaign.technical.kitFiles.find((file) => file.sha256 === template)).toEqual({ sha256: template, size: 7_355, path: "the page's template (its HTML elements in order)", siteCount: 4 });
		const indicator = (await buildDossier(campaignId)).indicators.find((entry) => entry.value === template)!;
		expect(describeIndicatorEnglish(indicator)).toStartWith(`Identical page template (the same 66 HTML elements in the same order, text and attributes left out; SHA-256 ${template}) (4 sites)`);
		expect(describeIndicator(indicator)).toStartWith(`Identische Seitenvorlage (dieselben 66 HTML-Elemente in derselben Reihenfolge, ohne Text und Attribute; SHA-256 ${template}) (4 Seiten)`);
	});

	test("the public list shows every phishing site as its campaign's card, a campaign of one included", async () => {
		await campaignWithThreeSites();
		await reportedSite(16n, "unrelated-solo.com");
		await CampaignRepository.recordIndicators(memberOf(16n), [telegram("9999")]);
		const page = await listSubmissionCards();
		const campaignOf = (id: string) => page.submissions.find((card) => card.id === id)?.campaign;
		expect(campaignOf("11")).toMatchObject({ siteCount: 3 });
		expect(campaignOf("13")).toEqual(campaignOf("11"));
		expect(campaignOf("16")).toMatchObject({ siteCount: 1 });
		const items = groupByCampaign(page.submissions);
		expect(items.map((item) => item.type === "campaign" ? `campaign:${item.siteCount}:${item.titles.length}` : item.submission.id)).toEqual(["campaign:1:1", "campaign:3:3"]);
	});

	test("refuses to approve a text the sender would refuse, and keeps the draft", async () => {
		const campaignId = await campaignWithThreeSites();
		const route = await prepareComplaint(campaignId, "by-zcb", dependencies);
		await expect(approveDraftedMail(route.id, { subject: "Strafanzeige", body: "Siehe http://127.0.0.1/admin" })).rejects.toThrow(OperatorActionError);
		await expect(approveDraftedMail(route.id, { subject: "Strafanzeige", body: "x".repeat(20_001) })).rejects.toThrow(OperatorActionError);
		expect((await AbuseRepository.getRoute(route.id))?.status).toBe("awaiting_approval");
		expect(await sendJobs(route.id)).toEqual([]);
	});

	test("sends exactly the approved text, then reads the file number from the authority's reply", async () => {
		const campaignId = await campaignWithThreeSites();
		const route = await prepareComplaint(campaignId, "by-zcb", dependencies);
		const draft = route.resolutionSnapshot.approvalDraft as { subject: string; body: string };
		const edited = draft.body.replace("Sehr geehrte Damen und Herren,", "Sehr geehrte Damen und Herren,\n\nvorab telefonisch angekündigt.");
		await saveDraftedMail(route.id, { subject: draft.subject, body: edited });
		await approveDraftedMail(route.id, { subject: draft.subject, body: edited });
		expect((await AbuseRepository.getRoute(route.id))?.status).toBe("verified");
		expect(await sendJobs(route.id)).toHaveLength(1);
		await expect(approveDraftedMail(route.id)).rejects.toThrow("not waiting for approval");

		const raw = await deliver(route.id);
		expect(raw).toContain("To: cybercrime@gensta-ba.bayern.de");
		expect(raw).toContain("vorab telefonisch");
		expect(raw).toContain("filename=sites.csv");
		expect(raw).toContain("filename=indicators.csv");
		expect((await AbuseRepository.getRoute(route.id))?.status).toBe("awaiting_provider_reply");

		const [outbound] = (await AbuseRepository.listMailForReport(route.reportId)).filter((message) => message.direction === "outbound");
		const result = await ingestFetchedMail({
			uid: 901,
			source: Buffer.from([
				"From: Zentralstelle Cybercrime Bayern <cybercrime@gensta-ba.bayern.de>",
				`To: ${outbound!.replyAddress}`,
				`Subject: AW: ${outbound!.subject}`,
				`In-Reply-To: ${outbound!.messageId}`,
				"Message-Id: <zcb-reply-1@justiz.bayern.de>",
				"",
				"Sehr geehrter Herr Scheit,\r\nIhre Anzeige wird hier unter dem Aktenzeichen 401 UJs 12345/26 bearbeitet.\r\nIhr Zeichen: " + abuseCaseTag(route.reportId),
			].join("\r\n")),
		}, { mailbox: "phishing.support", uidValidity: 1700000000, intakeAddress: "report@phishing.support" }, { createIntakeSubmission: async () => { throw new Error("no intake"); } });
		expect(result).toMatchObject({ route: "reply" });
		const reply = (await AbuseRepository.listMailForReport(route.reportId)).find((message) => message.direction === "inbound");
		await classifyReply(reply!.id);

		const answered = await AbuseRepository.getRoute(route.id);
		expect(answered?.status).toBe("acknowledged");
		expect(answered?.caseReference).toBe("401 UJs 12345/26");
		expect((await AbuseRepository.listEvents(route.reportId)).some((event) => event.eventType === "referral.reply_received")).toBe(true);
		// No provider workflow (portal escalation, follow-up) is ever queued for an authority's answer.
		const db = await getDb();
		const queuedJobs = db.select().from(jobs).where(eq(jobs.routeId, route.id)).all();
		expect(queuedJobs.map((job): string => job.jobType).sort()).toEqual(["classify_provider_reply", "monitor_provider_reply", "send_email"]);
	});

	test("a supplement carries only the sites the authority has not received, under its file number", async () => {
		const campaignId = await campaignWithThreeSites();
		const complaint = await prepareComplaint(campaignId, "by-zcb", dependencies);
		await approveDraftedMail(complaint.id);
		await deliver(complaint.id);
		await setReferralCaseReference(complaint.id, "401 UJs 12345/26");
		await expect(prepareSupplement(campaignId, "by-zcb", dependencies)).rejects.toThrow("has received every site");

		await reportedSite(14n, "dhl-zoll-gebuehr.com", "abuse@other-host.example");
		await CampaignRepository.recordIndicators(memberOf(14n), [telegram("7001")]);
		const supplement = await prepareSupplement(campaignId, "by-zcb", dependencies);
		const draft = supplement.resolutionSnapshot.approvalDraft as { subject: string; body: string };
		expect(draft.subject).toBe(`Nachtrag zu Az. 401 UJs 12345/26 – 1 weitere Website der Phishing-Kampagne [${abuseCaseTag(supplement.reportId)}]`);
		expect(draft.body).toContain("https://dhl-zoll-gebuehr.com/login");
		expect(draft.body).not.toContain("https://dhl-paket-zustellung.com/login\n");
		expect(draft.body).toContain(`Die Kampagne umfasst damit 4 Websites; die Übersicht aller Websites: https://phishing.support/campaigns/${campaignId.toString()}`);
		expect(draft.body).toContain("Sie gibt sich als www.dhl.de aus.");
		expect(draft.body).toMatch(/Die Website wurde am \d\d\.\d\d\.\d{4}, \d\d:\d\d Uhr erfasst\./);
		expect(draft.body).toMatch(/Hostinger International Ltd\.: gemeldet am \d\d\.\d\d\.\d{4}, Antwort ausstehend/);
		expect(supplement.resolutionSnapshot.submissionIds).toEqual(["14"]);
		await expect(prepareSupplement(campaignId, "by-zcb", dependencies)).rejects.toThrow("still waits for approval");

		// A discarded supplement leaves the site unreported, so it can be drafted again.
		await discardDraftedMail(supplement.id);
		expect((await AbuseRepository.getRoute(supplement.id))?.status).toBe("discarded");
		const again = await prepareSupplement(campaignId, "by-zcb", dependencies);
		expect(again.id).not.toBe(supplement.id);
		expect(again.routeKey).toBe("authority:by-zcb:3");

		const overview = await getCampaignOverview(campaignId);
		expect(overview?.authorities.find((authority) => authority.id === "by-zcb")).toMatchObject({ hasComplaint: true, unreportedSiteCount: 0, caseReference: "401 UJs 12345/26" });
		expect(overview?.mails.map((mail) => mail.status).sort()).toEqual(["awaiting_approval", "awaiting_provider_reply", "discarded"]);
	});

	test("preservation notices go to every provider mailbox once the case has a file number", async () => {
		const campaignId = await campaignWithThreeSites();
		await reportedSite(14n, "dhl-zoll-gebuehr.com", "abuse@other-host.example");
		await CampaignRepository.recordIndicators(memberOf(14n), [telegram("7001")]);
		await expect(preparePreservationNotices(campaignId, dependencies)).rejects.toThrow("file number");

		const complaint = await prepareComplaint(campaignId, "by-zcb", dependencies);
		await setReferralCaseReference(complaint.id, "401 UJs 12345/26");
		const notices = await preparePreservationNotices(campaignId, dependencies);
		expect(notices.map((notice) => notice.verifiedEmail).sort()).toEqual(["abuse@hostinger.example", "abuse@other-host.example"]);
		const hostinger = notices.find((notice) => notice.verifiedEmail === "abuse@hostinger.example")!;
		const draft = hostinger.resolutionSnapshot.approvalDraft as { subject: string; body: string };
		expect(draft.subject).toBe(`Data preservation request – criminal case 401 UJs 12345/26 – 2 phishing sites [${abuseCaseTag(hostinger.reportId)}]`);
		expect(draft.body).toContain("https://dhl-paket-zustellung.com/login (reported to you on");
		expect(draft.body).toContain("We are not asking you to disclose any of these records to us.");
		expect(draft.body).not.toContain("paket-dhl-info.org");
		expect(hostinger.status).toBe("awaiting_approval");
		await expect(preparePreservationNotices(campaignId, dependencies)).rejects.toThrow("already has a preservation notice");
	});

	test("a file number is set by hand only on an authority's mail, in a sane form", async () => {
		const campaignId = await campaignWithThreeSites();
		const complaint = await prepareComplaint(campaignId, "by-zcb", dependencies);
		await expect(setReferralCaseReference(complaint.id, "<script>")).rejects.toThrow(ReferralError);
		await setReferralCaseReference(complaint.id, " 12 Js 345/26 ");
		expect((await AbuseRepository.getRoute(complaint.id))?.caseReference).toBe("12 Js 345/26");
		await setReferralCaseReference(complaint.id, null);
		expect((await AbuseRepository.getRoute(complaint.id))?.caseReference).toBeNull();
		const events = await AbuseRepository.listEvents(complaint.reportId);
		expect(events.filter((event) => event.eventType === "route.case_reference_set")).toHaveLength(2);
	});

	test("an unknown authority, a missing campaign and a missing complainant are refused before anything is stored", async () => {
		const campaignId = await campaignWithThreeSites();
		await expect(prepareComplaint(campaignId, "nowhere", dependencies)).rejects.toThrow("Unknown authority");
		await expect(prepareComplaint(999n, "by-zcb", dependencies)).rejects.toThrow("does not exist");
		await expect(prepareComplaint(campaignId, "by-zcb", { ...dependencies, complainant: undefined })).rejects.toThrow("REFERRAL_COMPLAINANT_NAME");
		expect(await AbuseRepository.getCampaignReport(campaignId)).toBeUndefined();
	});
});
