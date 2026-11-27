import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SiteVisitBrowser, SiteVisitTimeline } from "./SiteVisitPanel";
import type { LiveControl } from "./live_visit/live_state";
import type { LiveFrame, LiveVisit } from "./live_visit/useLiveVisit";

const FRAME: LiveFrame = { src: "blob:frame", url: "https://kit.example/login", width: 1280, height: 800 };

function liveVisit(control: Partial<LiveControl> | undefined, frame: LiveFrame | null = null): LiveVisit {
	return {
		submissionId: "case",
		entries: [],
		...(control ? { control: { run: "r1", seq: 1, mode: "loading", tabs: [], fakeValues: {}, agentRunning: false, ...control } } : {}),
		finished: false,
		live: Boolean(control) && control?.mode !== "ended",
		frame,
		you: false,
		connected: true,
		setQuality: () => undefined,
	};
}

const browser = (visit: LiveVisit, running = true) => renderToStaticMarkup(<SiteVisitBrowser running={running} pages={[]} live={visit} fallbackUrl="https://kit.example/" />);
const timeline = (visit: LiveVisit) => renderToStaticMarkup(<SiteVisitTimeline running visit={undefined} live={visit} pageCount={0} />);

describe("the case's browser while the site loads", () => {
	test("before the first frame: what happens, else that it waits for the browser", () => {
		const html = browser(liveVisit({ status: "Starting browser via residential exit…" }));
		expect(html).toContain("Starting browser via residential exit…");
		expect(html).toContain("animate-spin");
		expect(html).not.toContain("Waiting for the browser…");
		expect(browser(liveVisit(undefined))).toContain("Waiting for the browser…");
		expect(browser(liveVisit({ mode: "loading" }))).toContain("Waiting for the browser…");
		// A visit that is not running says why nothing shows, not what loads.
		expect(browser(liveVisit({ status: "Starting browser via residential exit…" }), false)).toContain("No screenshot of this page.");
	});

	test("with a frame: the live picture at once, with what happens over it, until the agent walks", () => {
		const loading = browser(liveVisit({ status: "Loading page via Tor exit…" }, FRAME));
		expect(loading).toContain('src="blob:frame"');
		expect(loading).toContain("Open live view");
		expect(loading).toContain("Loading page via Tor exit…");
		expect(loading).toContain('role="status"');
		expect(loading).toContain("truncate");
		expect(loading).toContain("Open the live view to watch the site load in full screen");
		expect(browser(liveVisit({}, FRAME))).toContain("Loading the site…");

		const walking = browser(liveVisit({ mode: "agent", agentRunning: true }, FRAME));
		expect(walking).toContain('src="blob:frame"');
		expect(walking).toContain("take over the browser or message the agent");
		expect(walking).not.toContain("Loading the site…");
		expect(walking).not.toContain("animate-spin");
	});

	test("the timeline says what happens until the agent's first step", () => {
		expect(timeline(liveVisit({ status: "Residential exit failed (timeout), trying Tor exit…" }))).toContain("Residential exit failed (timeout), trying Tor exit…");
		expect(timeline(liveVisit({ mode: "agent", agentRunning: true }))).toContain("The agent is starting…");
		const stepped = { ...liveVisit({ status: "Loading page via Tor exit…" }), entries: [{ kind: "step" as const, url: "https://kit.example/", title: "Sign in" }] };
		expect(timeline(stepped)).not.toContain("Loading page via Tor exit…");
	});
});
