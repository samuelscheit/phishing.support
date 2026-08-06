import { dirname, join } from "node:path";
import fs from "node:fs";
import { getBrowserPage } from "./browser/page";
import { getBrowser } from "./browser/browser";

process.env["DEBUG"] = "puppeteer:*";
process.env["DEBUG_MAX_STRING_LENGTH"] = "null";

const browser = await getBrowser();

const context = await browser.createBrowserContext();

const p = await context.newPage();

const { page } = await getBrowserPage(p);

await page.goto("https://saewar.com/De56Mgw1A", {
	waitUntil: "load",
});

// await page.goto("https://ipapi.co/json/");
// https://saewar.com/De56Mgw1A

// await page.goto("https://bot-detector.rebrowser.net/");

const imagepath = join(__dirname, "..", "..", "data", "headless_test.png");

fs.mkdirSync(dirname(imagepath), { recursive: true });

// await page.waitForSelector(".container-fluid", { visible: true });

await page.screenshot({ path: imagepath, captureBeyondViewport: true, fullPage: true });

console.log("done");

// await page.close();

// await context.close();

// await browser.close();

// process.exit(0);
