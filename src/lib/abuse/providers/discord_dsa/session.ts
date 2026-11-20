import type { Page } from "rebrowser-puppeteer-core";

import { getBrowser } from "../../../browser";
import { snippet } from "../kit/text";
import { DISCORD_DSA_PROVIDER } from "./definition";
import type { DiscordDsaReport } from "./payload";

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

/** Text the page shows once a step has rendered, with white space collapsed. */
async function pageText(page: Page): Promise<string> {
	return page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
}

async function waitForText(page: Page, text: string, step: string): Promise<void> {
	try {
		await page.waitForFunction((wanted) => document.body.innerText.includes(wanted), { timeout: 30_000 }, text);
	} catch {
		throw new Error(`Discord's report form did not show "${text}" ${step}; it showed: ${snippet(await pageText(page))}`);
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
	if (!marked) throw new Error(`Discord's report form has no "${text}" to click; it showed: ${snippet(await pageText(page))}`);
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
export async function openDiscordDsaSession(): Promise<DiscordDsaSession> {
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
