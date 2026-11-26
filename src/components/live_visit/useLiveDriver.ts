"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { LiveInput } from "@/lib/site_visit/live_input";
import { InputQueue } from "./input_queue";
import type { Command, CommandResult } from "./live_channel";
import { driverStatus, type DriverStatus } from "./live_state";
import type { LiveVisit } from "./useLiveVisit";

type CommandKind = Command["type"];

/** The controls this viewer has of a live visit, as its views take them: what `useLiveDriver` returns, or a fixture. */
export type LiveDriver = {
	status: DriverStatus;
	/** The commands running now, for their buttons' busy state. */
	busy: Partial<Record<CommandKind, boolean>>;
	error?: string;
	dismissError: () => void;
	take: () => Promise<void>;
	release: (note?: string) => Promise<void>;
	/** Write to the agent; resolves whether the visit took the message. */
	message: (text: string) => Promise<boolean>;
	/** Inputs for the page, sent in order while the browser is this viewer's. */
	send: (...inputs: LiveInput[]) => void;
};

const NOT_CONNECTED: CommandResult = { ok: false, status: 0, error: "Not connected to the visit; try again in a moment." };

/**
 * Take over a live visit's browser, drive it and hand it back, or write to
 * the agent, over the visit's socket. Whether this viewer drives is what the
 * socket says (`you`), so a reload or a dropped connection drives on.
 */
export function useLiveDriver({ control, you, channel, connected }: Pick<LiveVisit, "control" | "you" | "channel" | "connected">): LiveDriver {
	const [busy, setBusy] = useState<LiveDriver["busy"]>({});
	const [error, setError] = useState<string>();
	/** Whether the console that drives is still open: a take answered after it closed is handed straight back. */
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const status = driverStatus(control, you);
	const queue = useMemo(() => new InputQueue({ send: (inputs) => channel?.input(inputs) ?? false }), [channel]);
	useEffect(() => () => queue.clear(), [queue]);
	useEffect(() => queue.setReady(status.kind === "you" && connected), [queue, status.kind, connected]);
	useEffect(() => {
		if (!you) queue.clear();
	}, [queue, you]);
	useEffect(() => channel?.onRefused((refusal) => {
		// Not (or no longer) the driver: what waits is not this viewer's to send.
		if (refusal.status === 403) queue.clear();
		setError(refusal.error);
	}), [channel, queue]);

	const run = useCallback(async (command: Command): Promise<CommandResult> => {
		setBusy((current) => ({ ...current, [command.type]: true }));
		setError(undefined);
		const result = channel ? await channel.request(command) : NOT_CONNECTED;
		setBusy((current) => ({ ...current, [command.type]: false }));
		if (!result.ok) setError(result.error);
		return result;
	}, [channel]);

	return {
		status,
		busy,
		error,
		dismissError: () => setError(undefined),
		take: async () => {
			const result = await run({ type: "take" });
			if (result.ok && !mounted.current) void channel?.request({ type: "release" });
		},
		release: async (note) => {
			if (!you) return;
			await run({ type: "release", ...(note?.trim() ? { note: note.trim() } : {}) });
		},
		message: async (text) => (await run({ type: "message", text })).ok,
		send: (...inputs) => {
			if (you) queue.push(...inputs);
		},
	};
}
