import type { Page } from "rebrowser-puppeteer-core";

import { getBrowser } from "../../../browser";
import { serviceIdentity } from "../../../constants";
import { abuseEmailCaseUrl } from "../../mail/draft";
import { routeContext } from "../../worker/shared";
import { providerDefinitionMatchesPin } from "../definition";
import { mailedCodeReader, type MailedCodeReader } from "../mailed_code";
import {
	ProviderSubmissionNeedsHumanError,
	ProviderSubmissionRejectedError,
	type ProviderSubmissionContext,
	type ProviderSubmissionPreflight,
	type ProviderSubmissionPreparation,
	type ProviderSubmissionSuccess,
} from "../submission_contracts";
import { DISCORD_DSA_PROVIDER } from "./definition";
import { asRecord } from "../../../values";

/** What one notice says: the server, why, and who files it. */
export type DiscordDsaReport = {
	serverId: string;
	description: string;
	reporter: { name: string; country: string; email: string };
};

type DiscordDsaPayload = {
	adapter: "discord_dsa_notice_v1";
	definition: { version: string; contentHash: string };
	report: DiscordDsaReport;
};

/** A browser on Discord's report form, driven one step at a time. */
export type DiscordDsaSession = {
	/** Open the server report and have Discord mail its key to `email`. */
	requestCode(email: string): Promise<void>;
	/** Enter the key and every step of the report, up to its summary. */
	fill(code: string, report: DiscordDsaReport): Promise<void>;
	/** Press "Submit Report"; resolves with what the form then shows. */
	submit(): Promise<string>;
	close(): Promise<void>;
};

export type DiscordDsaDependencies = {
	openSession?: () => Promise<DiscordDsaSession>;
	readCode?: MailedCodeReader;
	loadRouteContext?: typeof routeContext;
	now?: () => Date;
	environment?: Readonly<Record<string, string | undefined>>;
};

/** The probe's record of the webhook: the kit's page, when, and the webhook's server and channel. */
type WebhookEvidence = { pageUrl: string; observedAt: string; submissionId?: string; webhookId: string; guildId?: string; channelId?: string };

function webhookEvidence(artifacts: ReadonlyArray<{ name: string; mimeType: string; blob: Buffer }>): WebhookEvidence | undefined {
	const artifact = artifacts.find((candidate) => candidate.name === "exfiltration-evidence.json" && candidate.mimeType === "application/json");
	if (!artifact) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(artifact.blob.toString("utf-8"));
	} catch {
		return undefined;
	}
	const evidence = asRecord(parsed);
	const discord = asRecord(asRecord(evidence?.backend)?.discord);
	if (typeof evidence?.pageUrl !== "string" || typeof evidence.observedAt !== "string" || typeof discord?.webhookId !== "string") return undefined;
	return {
		pageUrl: evidence.pageUrl,
		observedAt: evidence.observedAt,
		...(typeof evidence.submissionId === "string" ? { submissionId: evidence.submissionId } : {}),
		webhookId: discord.webhookId,
		...(typeof discord.guildId === "string" ? { guildId: discord.guildId } : {}),
		...(typeof discord.channelId === "string" ? { channelId: discord.channelId } : {}),
	};
}

/**
 * Why the server's content is illegal, in the form's 512 characters: the kit,
 * the webhook it sends visitors' data to, the controlled test that showed it,
 * the law it breaks, and the case holding the evidence. A long page URL
 * gives way to its host before anything else is cut.
 */
export function discordDsaDescription(evidence: WebhookEvidence, caseUrl: string | undefined): string {
	const { maximumDescriptionLength } = DISCORD_DSA_PROVIDER.form;
	const at = `${evidence.observedAt.slice(0, 16).replace("T", " ")} UTC`;
	const build = (page: string) => [
		`Credential phishing. ${page} sends the passwords and data visitors enter to Discord webhook ${evidence.webhookId}${evidence.channelId ? ` (channel ${evidence.channelId})` : ""} of this server.`,
		`Our controlled test with synthetic data on ${at} confirmed it.`,
		DISCORD_DSA_PROVIDER.legalBasis,
		...(caseUrl ? [`Evidence: ${caseUrl}`] : []),
	].join(" ");
	const full = build(evidence.pageUrl);
	return full.length <= maximumDescriptionLength ? full : build(new URL(evidence.pageUrl).hostname).slice(0, maximumDescriptionLength);
}

function storedPayload(value: unknown): DiscordDsaPayload | undefined {
	const payload = asRecord(value);
	const definition = payload && asRecord(payload.definition);
	const report = payload && asRecord(payload.report);
	const reporter = report && asRecord(report.reporter);
	if (payload?.adapter !== "discord_dsa_notice_v1"
		|| definition?.version !== DISCORD_DSA_PROVIDER.version || definition.contentHash !== DISCORD_DSA_PROVIDER.contentHash
		|| typeof report?.serverId !== "string" || !/^\d{17,20}$/.test(report.serverId)
		|| typeof report.description !== "string" || !report.description || report.description.length > DISCORD_DSA_PROVIDER.form.maximumDescriptionLength
		|| typeof reporter?.name !== "string" || !reporter.name || typeof reporter.country !== "string" || !reporter.country || typeof reporter.email !== "string") {
		return undefined;
	}
	return {
		adapter: "discord_dsa_notice_v1",
		definition: { version: definition.version, contentHash: definition.contentHash },
		report: { serverId: report.serverId, description: report.description, reporter: { name: reporter.name, country: reporter.country, email: reporter.email } },
	};
}

/**
 * Pin the notice before the marker. The reporter is a real person the DSA
 * requires the notice to name (`DISCORD_DSA_REPORTER_NAME`, and an EU
 * `DISCORD_DSA_REPORTER_COUNTRY` as the form lists it); without one the
 * route waits for a person.
 */
export async function prepareDiscordDsaSubmission(context: ProviderSubmissionContext, dependencies: DiscordDsaDependencies = {}): Promise<ProviderSubmissionPreparation> {
	const { route, report, target, evidenceArtifacts } = await (dependencies.loadRouteContext ?? routeContext)(context.routeId);
	if (route.providerRegistryKey !== DISCORD_DSA_PROVIDER.key || target.targetType !== "service_account") {
		return { outcome: "insufficient_evidence", reason: "discord_dsa_requires_a_webhook_target" };
	}
	if (!providerDefinitionMatchesPin(DISCORD_DSA_PROVIDER, route.providerDefinitionVersion, route.providerDefinitionHash)) {
		return { outcome: "insufficient_evidence", reason: "discord_dsa_provider_definition_pin_mismatch" };
	}
	const evidence = webhookEvidence(evidenceArtifacts);
	if (!evidence || target.normalizedTarget !== `discord-webhook:${evidence.webhookId}`) {
		return { outcome: "insufficient_evidence", reason: "discord_dsa_requires_the_probe_evidence" };
	}
	if (!evidence.guildId || !/^\d{17,20}$/.test(evidence.guildId)) {
		return { outcome: "insufficient_evidence", reason: "discord_dsa_requires_the_webhook_server_id" };
	}
	const environment = dependencies.environment ?? process.env;
	const name = environment.DISCORD_DSA_REPORTER_NAME?.trim();
	const country = environment.DISCORD_DSA_REPORTER_COUNTRY?.trim();
	if (!name || !country) throw new ProviderSubmissionNeedsHumanError("Discord's DSA form needs the reporter's legal name and EU country: set DISCORD_DSA_REPORTER_NAME and DISCORD_DSA_REPORTER_COUNTRY.");
	const caseUrl = abuseEmailCaseUrl(report.submissionId ?? (evidence.submissionId ? BigInt(evidence.submissionId) : undefined));
	return {
		outcome: "ready",
		payload: {
			adapter: "discord_dsa_notice_v1",
			definition: { version: DISCORD_DSA_PROVIDER.version, contentHash: DISCORD_DSA_PROVIDER.contentHash },
			report: { serverId: evidence.guildId, description: discordDsaDescription(evidence, caseUrl), reporter: { name, country, email: serviceIdentity.mailbox } },
		} satisfies DiscordDsaPayload,
	};
}

/**
 * Before the marker: have Discord mail its key, read it, and fill every step
 * up to the summary. Nothing is filed until "Submit Report", so every failure
 * here is a safe retry.
 */
export async function prepareDiscordDsaExternalSubmission(context: ProviderSubmissionContext, dependencies: DiscordDsaDependencies = {}): Promise<ProviderSubmissionPreflight> {
	const payload = storedPayload(context.payload);
	if (!payload) throw new Error("The persisted Discord DSA payload is malformed.");
	const session = await (dependencies.openSession ?? openDiscordDsaSession)();
	try {
		const requestedAt = (dependencies.now ?? (() => new Date()))();
		await session.requestCode(payload.report.reporter.email);
		const code = await (dependencies.readCode ?? mailedCodeReader(DISCORD_DSA_PROVIDER.codeMail))(requestedAt, context.signal);
		await session.fill(code, payload.report);
		return { state: session, dispose: () => session.close() };
	} catch (error) {
		await session.close();
		throw error;
	}
}

/** The one irreversible step: "Submit Report" on the filled summary. */
export async function submitDiscordDsaSubmission(context: ProviderSubmissionContext, preflight: ProviderSubmissionPreflight | undefined): Promise<ProviderSubmissionSuccess> {
	const payload = storedPayload(context.payload);
	if (!payload) throw new Error("The persisted Discord DSA payload is malformed.");
	const session = preflight?.state as DiscordDsaSession | undefined;
	if (!session?.submit) throw new Error("Discord DSA submission requires the filled form from its preflight.");
	const answer = await session.submit();
	if (!/report submitted/i.test(answer)) throw new ProviderSubmissionRejectedError(`Discord did not confirm the report: ${answer.slice(0, 300)}`);
	return {
		confirmationText: `Discord accepted the DSA notice about server ${payload.report.serverId}: "${answer.replace(/\s+/g, " ").trim().slice(0, 200)}"`,
		finalUrl: DISCORD_DSA_PROVIDER.reportUrl,
		submittedTargets: [`discord-server:${payload.report.serverId}`],
	};
}

/** Text the page shows once a step has rendered, with white space collapsed. */
async function pageText(page: Page): Promise<string> {
	return page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
}

async function waitForText(page: Page, text: string, step: string): Promise<void> {
	try {
		await page.waitForFunction((wanted) => document.body.innerText.includes(wanted), { timeout: 30_000 }, text);
	} catch {
		throw new Error(`Discord's report form did not show "${text}" ${step}; it showed: ${(await pageText(page)).slice(0, 300)}`);
	}
}

/**
 * Click the element whose own text is exactly `text` (a button, a choice, an
 * option) with the mouse, as a person would: the form's dropdown opens on a
 * real mousedown, not on a scripted click.
 */
async function clickText(page: Page, text: string, selector = "button, [role=option], [role=button], [tabindex], label, div, span"): Promise<void> {
	const marked = await page.evaluate((wanted, candidates) => {
		document.querySelector("[data-ps-click]")?.removeAttribute("data-ps-click");
		// The innermost element showing exactly the text, then the nearest
		// element of the wanted kind around it (a button's caption sits in a
		// child). The last visible one: a step that is leaving can still be in
		// the page beside the one that replaced it.
		const leaf = [...document.querySelectorAll<HTMLElement>("body *")].filter((element) => {
			if (element.innerText?.trim() !== wanted || [...element.children].some((child) => (child as HTMLElement).innerText?.trim() === wanted)) return false;
			const box = element.getBoundingClientRect();
			return box.width > 0 && box.height > 0;
		}).at(-1);
		const target = leaf?.closest<HTMLElement>(candidates);
		target?.setAttribute("data-ps-click", "");
		return Boolean(target);
	}, text, selector);
	if (!marked) throw new Error(`Discord's report form has no "${text}" to click; it showed: ${(await pageText(page)).slice(0, 300)}`);
	await page.click("[data-ps-click]");
}

/** Type into the nth visible text field, as a person would. */
async function typeInto(page: Page, index: number, value: string, selector = "input[type=text]"): Promise<void> {
	const fields = await page.$$(selector);
	const field = fields[index];
	if (!field) throw new Error(`Discord's report form has no field ${index + 1} (${selector}).`);
	await field.click({ count: 3 });
	await field.type(value, { delay: 15 });
}

/** A Fabric browser on discord.com/report, over the reporting egress. */
async function openDiscordDsaSession(): Promise<DiscordDsaSession> {
	const browser = await getBrowser("reporting");
	try {
		const page = await browser.defaultBrowserContext().newPage();
		const { form } = DISCORD_DSA_PROVIDER;
		return {
			requestCode: async (email) => {
				await page.goto(DISCORD_DSA_PROVIDER.reportUrl, { waitUntil: "networkidle2", timeout: 60_000 });
				await clickText(page, form.reportType);
				await waitForText(page, "Your Email", "after choosing the server report");
				await typeInto(page, 0, email);
				await clickText(page, "Next", "button");
				await waitForText(page, "Verification Code", "after asking for the email key");
			},
			fill: async (code, report) => {
				await typeInto(page, 0, code);
				await clickText(page, "Verify", "button");
				await waitForText(page, "Full legal name", "after the email key");
				// Country of residence, full legal name, Discord username (left empty), server ID.
				await clickText(page, "Select...", "div, span");
				await page.waitForSelector("[role=option]", { timeout: 15_000 });
				await clickText(page, report.reporter.country, "[role=option]");
				await typeInto(page, 0, report.reporter.name);
				await typeInto(page, 2, report.serverId);
				await clickText(page, "Next", "button");
				await waitForText(page, "Where is this happening?", "after the reporter's details");
				await clickText(page, form.element);
				await clickText(page, "Next", "button");
				await waitForText(page, "best describes the illegal content", "after choosing what the report is about");
				await clickText(page, form.category);
				await waitForText(page, "why this content is illegal", "after choosing the category");
				await typeInto(page, 0, report.description, "textarea");
				await clickText(page, "Next", "button");
				await waitForText(page, "accurate and complete", "after the description");
				await page.evaluate(() => {
					const box = document.querySelector<HTMLInputElement>("input[type=checkbox]");
					if (box && !box.checked) box.click();
				});
				// "Next" only goes on once the form has taken the declaration.
				try {
					await page.waitForFunction(() => {
						const box = document.querySelector<HTMLInputElement>("input[type=checkbox]");
						const next = [...document.querySelectorAll("button")].find((button) => button.innerText.trim() === "Next");
						return Boolean(box?.checked && next && !next.disabled && next.getAttribute("aria-disabled") !== "true");
					}, { timeout: 10_000 });
				} catch {
					throw new Error("Discord's report form did not take the good-faith declaration.");
				}
				await clickText(page, "Next", "button");
				await waitForText(page, "Submit Report", "after the declaration");
			},
			submit: async () => {
				await clickText(page, "Submit Report", "button");
				await page.waitForFunction(() => /Report Submitted|error|failed|try again/i.test(document.body.innerText), { timeout: 30_000 }).catch(() => undefined);
				return pageText(page);
			},
			close: () => browser.close().catch(() => undefined),
		};
	} catch (error) {
		await browser.close().catch(() => undefined);
		throw error;
	}
}
