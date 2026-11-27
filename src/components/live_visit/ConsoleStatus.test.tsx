import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ControlDock } from "./ConsoleControls";
import { DriverBadge, driverText } from "./ConsoleStatus";
import { driverStatus, type DriverStatus, type LiveControl } from "./live_state";
import type { LiveDriver } from "./useLiveDriver";

const control = (overrides: Partial<LiveControl> = {}): LiveControl => ({ run: "r1", seq: 1, mode: "agent", tabs: [], fakeValues: {}, agentRunning: true, ...overrides });
const driver = (status: DriverStatus): LiveDriver => ({ status, busy: {}, dismissError: () => undefined, take: async () => undefined, release: async () => undefined, message: async () => true, send: () => undefined });

describe("the console while the site loads", () => {
	test("the badge stays concise with a spinner and puts detailed exit status in its tooltip", () => {
		expect(driverText({ kind: "loading", status: "Loading page via Tor exit…" })).toEqual({ text: "Loading site…", tone: "agent" });
		expect(driverText({ kind: "loading" })).toEqual({ text: "Loading site…", tone: "agent" });
		const badge = renderToStaticMarkup(<DriverBadge status={{ kind: "loading", status: "Residential exit failed (timeout), trying Tor exit…" }} />);
		expect(badge).toContain("animate-spin");
		expect(badge).toContain("Loading site…");
		expect(badge).toContain('title="Residential exit failed (timeout), trying Tor exit…"');
		expect(badge).toContain("shrink-0");
		expect(badge).toContain('role="status"');
		expect(renderToStaticMarkup(<DriverBadge status={{ kind: "loading" }} live={false} />)).not.toContain('role="status"');
		expect(renderToStaticMarkup(<DriverBadge status={{ kind: "agent" }} />)).toContain("shrink-0");
		expect(renderToStaticMarkup(<DriverBadge status={{ kind: "agent" }} />)).not.toContain("animate-spin");
	});

	test("take over waits for the agent, with why; nobody writes to an agent that has not started", () => {
		const loading = control({ mode: "loading", agentRunning: false, status: "Loading page via Tor exit…" });
		const dock = renderToStaticMarkup(<ControlDock driver={driver(driverStatus(loading, false))} control={loading} onKeyboard={() => undefined} />);
		expect(dock).toMatch(/<button[^>]*disabled=""[^>]*>.*Take over<\/button>/);
		expect(dock).toContain("Take over unlocks once the site finishes loading.");
		expect(dock).not.toContain("Message the agent");

		const walking = control();
		const agentDock = renderToStaticMarkup(<ControlDock driver={driver(driverStatus(walking, false))} control={walking} onKeyboard={() => undefined} />);
		expect(agentDock).not.toMatch(/<button[^>]*disabled=""[^>]*>.*Take over<\/button>/);
		expect(agentDock).not.toContain("unlocks");
		expect(agentDock).toContain("Message the agent");
	});
});
