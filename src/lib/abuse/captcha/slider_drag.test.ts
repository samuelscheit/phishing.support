import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";

import puppeteer, { type Browser } from "rebrowser-puppeteer-core";

import { requestGnameCodeOnPage } from "../providers/gname/submission";
import { dragSliderToEnd, sliderTrack, type RandomSource } from "./slider_drag";

/** A reproducible random source (mulberry32). */
function seeded(seed: number): RandomSource {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

describe("slider track", () => {
	test("ends exactly at the distance, never steps back, and stays within a few pixels of the rail", () => {
		for (let seed = 1; seed <= 200; seed++) {
			const distance = 40 + seed * 3;
			const track = sliderTrack(distance, seeded(seed));
			expect(track.length).toBeGreaterThanOrEqual(38);
			expect(track.length).toBeLessThanOrEqual(56);
			expect(track.at(-1)!.dx).toBe(distance);
			for (let index = 0; index < track.length; index++) {
				const step = track[index]!;
				expect(step.dx).toBeGreaterThanOrEqual(index === 0 ? 0 : track[index - 1]!.dx);
				expect(step.dx).toBeLessThanOrEqual(distance);
				expect(Math.abs(step.dy)).toBeLessThanOrEqual(2.8);
				expect(step.delayMs).toBeGreaterThanOrEqual(10);
				expect(step.delayMs).toBeLessThanOrEqual(34);
			}
		}
	});

	test("moves like a hand: fast off the start, slow into the end, over a human span of time", () => {
		const track = sliderTrack(330, seeded(7));
		const third = Math.floor(track.length / 3);
		const firstThird = track[third - 1]!.dx;
		const lastThird = 330 - track[track.length - third - 1]!.dx;
		expect(firstThird).toBeGreaterThan(lastThird * 4);
		const duration = track.reduce((total, step) => total + step.delayMs, 0);
		expect(duration).toBeGreaterThan(380);
		expect(duration).toBeLessThan(1_910);
		// Uneven step times: a constant-interval replay is a bot's.
		expect(new Set(track.map((step) => step.delayMs)).size).toBeGreaterThan(5);
	});

	test("each drag is its own: two seeds never give the same track, one seed always does", () => {
		expect(sliderTrack(330, seeded(1))).toEqual(sliderTrack(330, seeded(1)));
		expect(sliderTrack(330, seeded(1))).not.toEqual(sliderTrack(330, seeded(2)));
	});

	test("a drag needs somewhere to go", () => {
		for (const distance of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => sliderTrack(distance)).toThrow("positive distance");
		}
		// A very short rail still ends on its end.
		expect(sliderTrack(1, seeded(3)).at(-1)!.dx).toBe(1);
	});
});

const chromiumExecutable = process.env.PHISHING_TEST_CHROMIUM
	?? `${homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const chromiumAvailable = await Bun.file(chromiumExecutable).exists();

/**
 * GNAME's form as far as the code request goes, served locally: `send_email`
 * posts, meets `-105001`, shows the GnSliderVerify widget, and posts again
 * with the slider's token. The widget passes only a track that reaches the
 * end of the rail with uneven speed, like `/request/slideverify`; `refuse`
 * makes it fail every drag.
 */
function serveGnameForm(options: { slider: boolean; refuse?: boolean; sendEmail?: boolean }) {
	const page = `<!DOCTYPE html><html><body>
<div id="dialog" style="display:none;position:fixed;top:200px;left:400px;width:400px">
	<div class="gn-slide-rail" style="position:relative;width:400px;height:46px;background:#eee">
		<div class="gn-slide-bar" style="position:absolute;left:0;top:0;width:68px;height:44px;background:#3a3"></div>
	</div>
</div>
<script>
window.sends = [];
window.tracks = [];
function post(data, callback) {
	window.sends.push(data);
	fetch("/request/send_email", { method: "POST", body: JSON.stringify(data) }).then((r) => r.json()).then(callback);
}
${options.sendEmail === false ? "" : `window.send_email = function (element, data, callback) {
	post(data, function (response) {
		if (response.code === -105001) return slider(function (token) { post(Object.assign({}, data, { re_yzm: token }), callback); });
		callback(response);
	});
};`}
function slider(done) {
	const dialog = document.getElementById("dialog");
	const rail = dialog.querySelector(".gn-slide-rail");
	const bar = dialog.querySelector(".gn-slide-bar");
	dialog.style.display = "block";
	let start, points;
	bar.onmousedown = (event) => { start = event.clientX; points = [[event.clientX, performance.now()]]; };
	document.onmousemove = (event) => {
		if (start === undefined) return;
		points.push([event.clientX, performance.now()]);
		bar.style.left = Math.max(0, Math.min(event.clientX - start, rail.clientWidth - bar.clientWidth)) + "px";
	};
	document.onmouseup = () => {
		if (start === undefined) return;
		const reached = parseFloat(bar.style.left) >= rail.clientWidth - bar.clientWidth;
		const gaps = points.slice(1).map((point, index) => point[1] - points[index][1]);
		const uneven = new Set(gaps.map((gap) => Math.round(gap / 4))).size > 3;
		window.tracks.push({ reached, uneven, moves: points.length });
		start = undefined;
		if (${options.refuse ? "false" : "true"} && reached && uneven) {
			dialog.style.display = "none";
			done("slider-token");
		} else {
			bar.style.left = "0px";
		}
	};
}
</script></body></html>`;
	return Bun.serve({
		port: 0,
		fetch: async (request) => {
			const { pathname } = new URL(request.url);
			if (pathname === "/request/send_email") {
				const data = await request.json() as Record<string, string>;
				if (options.slider && !data.re_yzm) return Response.json({ code: -105001, msg: "Request parameter error", data: { verify: { style: "slider", lx: "lyts" } } });
				return Response.json({ code: "1", msg: `An e-mail has been sent to your email address ${data.email}, please check it.`, data: "" });
			}
			return new Response(page, { headers: { "content-type": "text/html" } });
		},
	});
}

describe.skipIf(!chromiumAvailable)("GNAME's code request in a real browser", () => {
	async function onForm<T>(options: Parameters<typeof serveGnameForm>[0], run: (page: import("rebrowser-puppeteer-core").Page) => Promise<T>): Promise<T> {
		const server = serveGnameForm(options);
		let browser: Browser | undefined;
		try {
			browser = await puppeteer.launch({ executablePath: chromiumExecutable, headless: true, args: ["--no-first-run"], defaultViewport: { width: 1280, height: 900 } });
			const page = await browser.newPage();
			await page.goto(`http://127.0.0.1:${server.port}/`);
			return await run(page);
		} finally {
			await browser?.close();
			server.stop(true);
		}
	}

	test("a slider the form demands is dragged to its end with an uneven track, and the code request goes out with its token", async () => {
		await onForm({ slider: true }, async (page) => {
			const response = await requestGnameCodeOnPage(page, "support@phishing.support");
			expect(response).toEqual({ code: "1", msg: "An e-mail has been sent to your email address support@phishing.support, please check it.", data: "" });
			expect(await page.evaluate(() => (window as unknown as { sends: unknown[] }).sends)).toEqual([
				{ lx: "lyts", email: "support@phishing.support" },
				{ lx: "lyts", email: "support@phishing.support", re_yzm: "slider-token" },
			]);
			const tracks = await page.evaluate(() => (window as unknown as { tracks: Array<{ reached: boolean; uneven: boolean; moves: number }> }).tracks);
			expect(tracks).toHaveLength(1);
			expect(tracks[0]).toMatchObject({ reached: true, uneven: true });
			expect(tracks[0]!.moves).toBeGreaterThan(38);
		});
	}, 60_000);

	test("a form that sends the code without a slider is never dragged", async () => {
		await onForm({ slider: false }, async (page) => {
			expect(await requestGnameCodeOnPage(page, "support@phishing.support")).toMatchObject({ code: "1" });
			expect(await page.evaluate(() => (window as unknown as { tracks: unknown[] }).tracks)).toEqual([]);
		});
	}, 60_000);

	test("a slider that refuses every drag is tried three times, then the request fails without a code", async () => {
		await onForm({ slider: true, refuse: true }, async (page) => {
			await expect(requestGnameCodeOnPage(page, "support@phishing.support")).rejects.toThrow("GNAME's slider did not pass after 3 drags, so no code was sent.");
			expect(await page.evaluate(() => (window as unknown as { tracks: unknown[] }).tracks)).toHaveLength(3);
			expect(await page.evaluate(() => (window as unknown as { sends: unknown[] }).sends)).toHaveLength(1);
		});
	}, 120_000);

	test("a page without the form's send_email fails loudly", async () => {
		await onForm({ slider: false, sendEmail: false }, async (page) => {
			await expect(requestGnameCodeOnPage(page, "support@phishing.support")).rejects.toThrow("GNAME's form could not request a code: the page has no send_email");
		});
	}, 60_000);

	test("dragging a slider on its own reaches the end of its rail", async () => {
		await onForm({ slider: true }, async (page) => {
			await page.evaluate(() => (window as unknown as { slider(done: (token: string) => void): void }).slider(() => undefined));
			await dragSliderToEnd(page, { handle: ".gn-slide-bar", rail: ".gn-slide-rail" }, seeded(11));
			expect(await page.evaluate(() => (window as unknown as { tracks: Array<{ reached: boolean }> }).tracks)).toMatchObject([{ reached: true }]);
		});
	}, 60_000);
});
