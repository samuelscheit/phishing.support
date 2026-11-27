"use client";

import { useEffect, useState } from "react";

import { SiteVisitBrowser, SiteVisitTimeline } from "@/components/SiteVisitPanel";
import { LiveConsole } from "@/components/live_visit/LiveConsole";
import { driverStatus, type LiveControl, type LiveEntry } from "@/components/live_visit/live_state";
import type { LiveDriver } from "@/components/live_visit/useLiveDriver";
import type { LiveFrame, LiveVisit } from "@/components/live_visit/useLiveVisit";

const ME = "Viewer ab12";

/** A made-up phishing page, drawn as the screen would show it. */
function mockFrame(kind: "desktop" | "phone"): LiveFrame {
	const [width, height] = kind === "phone" ? [390, 844] : [1280, 800];
	const card = kind === "phone" ? { x: 24, y: 160, w: 342 } : { x: 440, y: 170, w: 400 };
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Helvetica, Arial, sans-serif">
<rect width="100%" height="100%" fill="#eef2f7"/>
<rect width="100%" height="64" fill="#0b3d91"/>
<text x="24" y="40" fill="#fff" font-size="22" font-weight="700">SecureBank</text>
<rect x="${card.x}" y="${card.y}" width="${card.w}" height="420" rx="12" fill="#fff" stroke="#d5dbe5"/>
<text x="${card.x + 28}" y="${card.y + 56}" font-size="22" font-weight="700" fill="#111">Sign in to online banking</text>
<text x="${card.x + 28}" y="${card.y + 84}" font-size="13" fill="#667">Your account was locked. Verify your identity.</text>
<text x="${card.x + 28}" y="${card.y + 128}" font-size="13" fill="#333">Email</text>
<rect x="${card.x + 28}" y="${card.y + 138}" width="${card.w - 56}" height="40" rx="6" fill="#fff" stroke="#9aa5b8"/>
<text x="${card.x + 40}" y="${card.y + 164}" font-size="14" fill="#111">maria.keller@example.test</text>
<text x="${card.x + 28}" y="${card.y + 208}" font-size="13" fill="#333">Password</text>
<rect x="${card.x + 28}" y="${card.y + 218}" width="${card.w - 56}" height="40" rx="6" fill="#fff" stroke="#2563eb" stroke-width="2"/>
<rect x="${card.x + 28}" y="${card.y + 290}" width="${card.w - 56}" height="44" rx="6" fill="#0b3d91"/>
<text x="${card.x + card.w / 2}" y="${card.y + 318}" font-size="15" fill="#fff" text-anchor="middle" font-weight="600">Continue</text>
<text x="${card.x + 28}" y="${card.y + 380}" font-size="12" fill="#2563eb">Forgot your password?</text>
</svg>`;
	return { src: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`, url: "https://secure-bank-verify.example.test/login/verify?session=8f2c", width, height };
}

const ENTRIES: LiveEntry[] = [
	{ kind: "step", url: "https://secure-bank-verify.example.test/", title: "SecureBank – Sign in" },
	{ kind: "action", text: "The page asks to verify a locked account; I'll follow it as a victim would.", actionKind: "thought", actor: "agent" },
	{ kind: "action", text: "Clicked a#verify \"Verify now\"", actionKind: "click", actor: "agent" },
	{ kind: "step", url: "https://secure-bank-verify.example.test/login/verify", title: "Verify your identity" },
	{ kind: "action", text: "Typed the made-up email into input#email", actionKind: "input_text", actor: "agent" },
	{ kind: "action", text: "Viewer ab12 took over the browser", actionKind: "takeover", actor: "human" },
	{ kind: "action", text: "Clicked input#password[type=password] \"Password\"", actionKind: "click", actor: "human" },
	{ kind: "action", text: "Entered the made-up password into input#password[type=password]", actionKind: "type", actor: "human" },
	{ kind: "action", text: "Scrolled down 320 px", actionKind: "scroll", actor: "human" },
	{ kind: "download", fileName: "SecureBank-Statement.pdf.exe", url: "https://secure-bank-verify.example.test/s.exe" },
];

const FAKE_VALUES: LiveControl["fakeValues"] = {
	email: "maria.keller@example.test", username: "mkeller84", password: "Tq7!vL2p#rW9", phone: "+49 151 23456789", cardNumber: "4539 1488 0343 6467", cardExpiry: "08/29", cardCvc: "317",
	oneTimeCode: "482913", name: "Maria Keller", address: "Lindenstraße 12", city: "Leipzig", postalCode: "04109", country: "Germany", dateOfBirth: "1984-03-17", companyOrPageName: "Keller Design",
};

function controlFor(state: string): LiveControl {
	const now = Date.now();
	const tabs = [
		{ targetId: "t1", url: "https://secure-bank-verify.example.test/login/verify", title: "Verify your identity", active: true },
		{ targetId: "t2", url: "https://secure-bank-verify.example.test/help", title: "", active: false },
	];
	const human = { controller: state === "other" ? "Viewer 7f3e" : ME, until: new Date(now + 9 * 60_000).toISOString(), idleUntil: new Date(now + 42_000).toISOString() };
	switch (state) {
		case "loading":
			return { run: "fixture", seq: 1, mode: "loading", status: "Residential exit failed (timeout), loading via Tor exit…", tabs: tabs.slice(0, 1), fakeValues: {}, agentRunning: false };
		case "pausing":
			return { run: "fixture", seq: 1, mode: "pausing", controller: ME, tabs, fakeValues: FAKE_VALUES, agentRunning: true };
		case "you":
		case "other":
			return { run: "fixture", seq: 1, mode: "human", ...human, tabs, fakeValues: FAKE_VALUES, agentRunning: true };
		case "ended":
			return { run: "fixture", seq: 1, mode: "ended", tabs: [], fakeValues: {}, agentRunning: false };
		default:
			return { run: "fixture", seq: 1, mode: "agent", tabs: tabs.slice(0, 1), fakeValues: FAKE_VALUES, agentRunning: true };
	}
}

export function LiveConsoleFixture({ state, frame, theme }: { state: string; frame: "desktop" | "phone"; theme: "light" | "dark" }) {
	const [open, setOpen] = useState(state !== "inline");
	const [mounted, setMounted] = useState(false);
	useEffect(() => {
		document.documentElement.classList.toggle("dark", theme === "dark");
		setMounted(true);
	}, [theme]);
	const control = controlFor(state);
	const loading = state === "loading";
	const visit: LiveVisit = {
		submissionId: "fixture",
		entries: loading ? [] : ENTRIES,
		control,
		finished: false,
		live: control.mode !== "ended",
		frame: mockFrame(frame),
		you: state === "you" || state === "pausing",
		connected: true,
		setQuality: () => undefined,
	};
	const driver: LiveDriver = {
		status: driverStatus(control, visit.you),
		error: undefined,
		dismissError: () => undefined,
		take: async () => undefined,
		release: async () => undefined,
		busy: {},
		message: async () => true,
		send: (...inputs) => console.info("live inputs", inputs),
	};
	if (!mounted) return null;
	return (
		<main className="mx-auto max-w-3xl space-y-6 p-6">
			{/* The dev tools' badge would cover the console's corner in screenshots. */}
			<style>{"nextjs-portal{display:none}"}</style>
			<SiteVisitBrowser running={control.mode !== "ended"} pages={[]} live={visit} fallbackUrl="https://secure-bank-verify.example.test/" />
			<SiteVisitTimeline running={loading} visit={loading ? undefined : { outcome: "completed", actions: ENTRIES.flatMap((entry) => (entry.kind === "action" ? [{ kind: entry.actionKind, text: entry.text, actor: entry.actor }] : [])), accessSteps: [], dataSent: [], downloadFailures: [] }} live={visit} pageCount={loading ? 0 : 2} />
			{open ? <LiveConsole visit={visit} driver={driver} onClose={() => setOpen(false)} fullscreen={false} /> : null}
		</main>
	);
}
