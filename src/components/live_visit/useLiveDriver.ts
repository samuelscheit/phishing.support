"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { LiveInput } from "@/lib/site_visit/live_input";
import { InputQueue, type PostResult } from "./input_queue";
import { driverStatus, reconcileToken, type DriverStatus, type DriverToken } from "./live_state";
import type { LiveVisit } from "./useLiveVisit";

/** Where this browser tab keeps its viewer id: a reload keeps the controls, another tab is another viewer. */
const VIEWER_KEY = "liveVisitViewer";

/** This tab's viewer id: its key to the controls, never shown. */
function viewerId(): string {
	const stored = sessionStorage.getItem(VIEWER_KEY);
	if (stored && /^[A-Za-z0-9-]{16,64}$/.test(stored)) return stored;
	const created = crypto.randomUUID();
	sessionStorage.setItem(VIEWER_KEY, created);
	return created;
}

/** How the visit names a viewer to others (`Viewer ab12`), as the server derives it. */
async function viewerLabel(viewer: string): Promise<string | undefined> {
	if (!globalThis.crypto?.subtle) return undefined;
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(viewer)));
	return `Viewer ${[...digest.slice(0, 2)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

type CommandResult = PostResult & { token?: string };

async function sendCommand(submissionId: string, body: Record<string, unknown>): Promise<CommandResult> {
	try {
		const response = await fetch(`/api/live/${encodeURIComponent(submissionId)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
		const answer = (await response.json().catch(() => ({}))) as { error?: string; token?: string };
		if (!response.ok) return { ok: false, status: response.status, error: answer.error ?? `The visit refused (${response.status}).` };
		return { ok: true, ...(answer.token ? { token: answer.token } : {}) };
	} catch {
		return { ok: false, status: 0, error: "The connection to the visit failed." };
	}
}

/** The controls this viewer has of a live visit, as its views take them: what `useLiveDriver` returns, or a fixture. */
export type LiveDriver = {
	status: DriverStatus;
	/** The command running now, for its button's busy state. */
	busy?: "take" | "release" | "message";
	error?: string;
	dismissError: () => void;
	take: () => Promise<void>;
	release: (note?: string) => Promise<void>;
	/** Write to the agent; resolves whether the visit took the message. */
	message: (text: string) => Promise<boolean>;
	/** Inputs for the page, sent in order once the browser is this viewer's. */
	send: (...inputs: LiveInput[]) => void;
};

/**
 * Take over a live visit's browser, drive it and hand it back, or write to
 * the agent. The take's token is this viewer's while the stream names it
 * the driver; a turn that ended (idle, time up, the visit over) lets go of it.
 */
export function useLiveDriver({ submissionId, control }: Pick<LiveVisit, "submissionId" | "control">): LiveDriver {
	const [viewer, setViewer] = useState<string>();
	const [label, setLabel] = useState<string>();
	const [held, setHeld] = useState<DriverToken>({ confirmed: false });
	const [busy, setBusy] = useState<LiveDriver["busy"]>();
	const [error, setError] = useState<string>();
	const tokenRef = useRef<string | undefined>(undefined);
	useEffect(() => {
		tokenRef.current = held.token;
	}, [held.token]);

	useEffect(() => {
		const id = viewerId();
		setViewer(id);
		void viewerLabel(id).then(setLabel);
	}, []);

	useEffect(() => setHeld((current) => reconcileToken(current, control, label)), [control, label]);

	const queue = useMemo(() => new InputQueue({
		post: (inputs) => sendCommand(submissionId, { action: "input", viewer, token: tokenRef.current, inputs }),
		onLost: (lost) => {
			setHeld({ confirmed: false });
			setError(lost);
		},
		onError: setError,
	}), [submissionId, viewer]);
	useEffect(() => () => queue.clear(), [queue]);

	// A reload, or a console closed and opened again, while this viewer drives: taking again returns its token.
	const ownTurn = !held.token && Boolean(label) && (control?.mode === "pausing" || control?.mode === "human") && control.controller === label;
	useEffect(() => {
		if (!ownTurn || !viewer) return;
		void sendCommand(submissionId, { action: "take", viewer }).then((result) => {
			if (result.ok && result.token) setHeld({ token: result.token, confirmed: false });
		});
	}, [ownTurn, viewer, submissionId]);

	const status = driverStatus(control, { label, driving: Boolean(held.token) });
	useEffect(() => queue.setReady(status.kind === "you"), [queue, status.kind]);
	useEffect(() => {
		if (!held.token) queue.clear();
	}, [queue, held.token]);

	const run = useCallback(async (kind: NonNullable<LiveDriver["busy"]>, body: Record<string, unknown>): Promise<CommandResult> => {
		setBusy(kind);
		setError(undefined);
		const result = await sendCommand(submissionId, { ...body, viewer });
		setBusy(undefined);
		if (!result.ok) setError(result.error);
		return result;
	}, [submissionId, viewer]);

	return {
		status,
		busy,
		error,
		dismissError: () => setError(undefined),
		take: async () => {
			const result = await run("take", { action: "take" });
			if (result.ok && result.token) setHeld({ token: result.token, confirmed: false });
		},
		release: async (note) => {
			if (!held.token) return;
			const result = await run("release", { action: "release", token: held.token, ...(note?.trim() ? { note: note.trim() } : {}) });
			// Refused because the turn already ended: the token is no good either way.
			if (result.ok || result.status === 403 || result.status === 404) setHeld({ confirmed: false });
		},
		message: async (text) => (await run("message", { action: "message", text })).ok,
		send: (...inputs) => {
			if (held.token) queue.push(...inputs);
		},
	};
}
