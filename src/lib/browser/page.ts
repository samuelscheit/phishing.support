import type {
	Browser,
	BrowserContext,
	CDPSession,
	ElementHandle,
	Frame,
	GoToOptions,
	HTTPResponse,
	Page,
	Protocol,
	PuppeteerLifeCycleEvent,
} from "rebrowser-puppeteer-core";
import { sleep } from "../utils";
import { getBrowser } from "./browser";

async function waitForCDPElement({
	cdp,
	nodeId,
	selector,
	intervalMs = 50,
	timeoutMs = 30000,
}: {
	cdp: CDPSession;
	nodeId: number;
	selector: string;
	timeoutMs?: number;
	intervalMs?: number;
}) {
	const start = Date.now();

	while (true) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`Timeout waiting for element matching selector: ${selector}`);
		}

		const { nodeId: elementNodeId } = await cdp.send("DOM.querySelector", {
			nodeId,
			selector,
		});

		if (elementNodeId && elementNodeId !== 0) {
			return elementNodeId;
		}

		await sleep(intervalMs);
	}
}

function recursiveSearchDocument(document: Protocol.DOM.Node, predicate: (node: Protocol.DOM.Node) => boolean): Protocol.DOM.Node | null {
	if (predicate(document)) {
		return document;
	}

	for (const child of document.children || []) {
		const result = recursiveSearchDocument(child, predicate);
		if (result) {
			return result;
		}
	}
	for (const child of document.shadowRoots || []) {
		const result = recursiveSearchDocument(child, predicate);
		if (result) {
			return result;
		}
	}

	return null;
}

export class DeferredPromise<T> {
	public promise: Promise<T>;
	public resolve!: (value: T | PromiseLike<T>) => void;
	public reject!: (reason?: any) => void;

	constructor() {
		this.promise = new Promise<T>((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;
		});
	}

	then(onfulfilled?: (value: T) => void, onrejected?: (reason: any) => void) {
		return this.promise.then(onfulfilled, onrejected);
	}

	catch(onrejected?: (reason: any) => void) {
		return this.promise.catch(onrejected);
	}
}

const isCloudflareChallengeUrl = (url: string) =>
	url.includes("challenges.cloudflare.com") || url.includes("/cdn-cgi/challenge-platform/") || url.includes("cf-challenge");

export async function getBrowserPage(p?: Page, proxy_country_code?: string) {
	const browser = (p ? p.browser() : await getBrowser()) as Browser;
	const context = (
		p
			? p.browserContext()
			: await browser.createBrowserContext({
					proxyServer: proxy_country_code ? process.env.PROXY_URL_NO_AUTH : undefined,
				})
	) as BrowserContext;

	const page = p || (await context.newPage());

	if (proxy_country_code) {
		await page.authenticate({
			username: proxy_country_code.toLowerCase(),
			password: "any",
		});
	}

	let cloudflareWait = new DeferredPromise<void>();

	// await page.setRequestInterception(true);

	// page.on("request", (request) => {
	// 	console.log("Requesting:", request.url());
	// 	request.continue();
	// });

	// page.on("response", async (response) => {
	// 	console.log("Received response:", response.status(), response.url());
	// });

	page.on("console", (msg) => {
		const type = msg.type();
		const text = msg.text();

		console.log(`[Browser Console] [${type}] ${text}`);
	});

	const waitForCloudflare = async (frame: Frame, page: Page) => {
		const source = page.url();

		console.log(`[Cloudflare] challenge (${source}), solving...`);

		await frame.waitForSelector(`body`);

		// @ts-ignore
		const target = browser.targets().find((x) => x._targetId === frame._id)!;
		const cdp = await target.createCDPSession();

		const document = await cdp.send("DOM.getDocument", {
			depth: -1,
			pierce: true,
		});

		const body = recursiveSearchDocument(document.root, (node) => node.nodeName.toLowerCase() === "body");

		const [root] = body?.shadowRoots || [];
		if (!root) throw new Error("No shadow root found in body");
		try {
			const input = await waitForCDPElement({
				cdp,
				nodeId: root.nodeId,
				selector: `input[type="checkbox"]`,
				timeoutMs: 30000,
			});

			const { node } = await cdp.send("DOM.describeNode", {
				nodeId: input,
				depth: -1,
				pierce: true,
			});

			const handle = (await (frame as any).mainRealm().adoptBackendNode(node.backendNodeId)) as ElementHandle<Element>;

			await handle.scrollIntoView();
			await sleep(300);

			await handle.click();
		} catch (error) {
			console.warn(`[Cloudflare] no checkbox found:`, (error as Error)?.message);
		}

		cloudflareWait.resolve();

		return cloudflareWait;
	};

	page.on("framenavigated", async (frame) => {
		const url = frame.url();

		if (isCloudflareChallengeUrl(url)) {
			await waitForCloudflare(frame, page);
		}
	});

	page.on("dialog", async (dialog) => {
		await sleep(1000 * Math.random() + 1000);
		await dialog.dismiss();
	});
	await page.setViewport({ width: 1920, height: 1080 });

	const originalGoto = page.goto.bind(page);

	async function handleResponse(response: HTTPResponse | null, waitUntil?: string, timeout = 30000) {
		// console.log("navigated", "status:", response?.status(), "url:", response?.url(), "headers:", response?.headers()["cf-mitigated"]);

		if (response?.status() === 403 && response.headers()["cf-mitigated"] === "challenge") {
			console.log("[Cloudflare] challenge (403), waiting...");
			// await waitForCloudflare("response 403");
			response = await page.waitForNavigation({
				waitUntil: "domcontentloaded",
				timeout: 30000,
			});

			cloudflareWait = new DeferredPromise<void>();

			await cloudflareWait;

			await page.waitForNavigation({ timeout: 30000 }).catch((error) => {
				console.warn(`Cloudflare wait timed out:`, error);
			});
			console.log("[Cloudflare] challenge passed");
		}

		if (waitUntil === "networkidle0") {
			await page.waitForNetworkIdle({
				concurrency: 0,
				idleTime: 500,
				timeout,
			});
		} else if (waitUntil === "networkidle2") {
			await page.waitForNetworkIdle({
				concurrency: 2,
				idleTime: 500,
				timeout,
			});
		} else if (waitUntil === "load") {
			const start = Date.now();
			while (true) {
				try {
					const readyState = await page.evaluate(() => document.readyState);
					if (readyState === "complete") break;
				} catch (error) {}
				if (Date.now() - start > timeout) {
					throw new Error(`Timeout waiting for load event`);
				}
				await sleep(50);
			}
		} else if (waitUntil === "domcontentloaded") {
			const start = Date.now();
			while (true) {
				try {
					var readyState = await page.evaluate(() => document.readyState);

					if (readyState === "interactive" || readyState === "complete") break;
				} catch (error) {}
				if (Date.now() - start > timeout) {
					throw new Error(`Timeout waiting for domcontentloaded event`);
				}
				await sleep(50);
			}
		}

		return response;
	}

	page.goto = async (url: string, options?: GoToOptions) => {
		const response = await originalGoto(url, {
			...options,
			waitUntil: "domcontentloaded",
		});

		return await handleResponse(response, (options?.waitUntil as PuppeteerLifeCycleEvent) || "load", options?.timeout || 30000);
	};

	return { page, context, browser };
}
