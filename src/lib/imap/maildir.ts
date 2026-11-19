import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import path from "node:path";

import { imapConfig, relayBounceMaildir } from "../mail_config";
import { sleep } from "../sleep";
import { ingestFetchedMail } from "./ingest";

/**
 * Bounces of our reports, which our relay files into a Maildir on the data
 * volume (docker/mailer). They cannot go to the iCloud mailbox: iCloud refuses
 * every delivery status notification our relay sends it (554 5.7.1 [HM08]).
 * Each message goes through the same ingest as IMAP mail; its ledger key is
 * this pseudo-mailbox and a UID derived from the file's unique name.
 */
const MAILBOX = "relay-bounces";
const UID_VALIDITY = 1;
const POLL_MS = 15_000;

/** A stable stand-in for an IMAP UID: 48 bits of the hash of the Maildir file's unique name. */
export function maildirUid(name: string): number {
	return Number.parseInt(createHash("sha256").update(name).digest("hex").slice(0, 12), 16);
}

/** Ingest every message in `dir`/new; one whose outcome is terminal moves to cur/, one to retry stays. */
export async function ingestMaildir(dir: string, intakeAddress: string): Promise<void> {
	let names: string[];
	try {
		names = (await readdir(path.join(dir, "new"))).filter((name) => !name.startsWith(".")).sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (names.length) await mkdir(path.join(dir, "cur"), { recursive: true });
	for (const name of names) {
		const file = path.join(dir, "new", name);
		const result = await ingestFetchedMail({ uid: maildirUid(name), source: await readFile(file) }, { mailbox: MAILBOX, uidValidity: UID_VALIDITY, intakeAddress });
		if (result.disposition === "retry") {
			console.error(`Relay bounce ${name} will be retried: ${result.reason}`);
			continue;
		}
		await rename(file, path.join(dir, "cur", `${name}:2,S`));
	}
}

let intake: { controller: AbortController; loop: Promise<void> } | undefined;

/** Poll the relay's bounce Maildir when RELAY_BOUNCE_MAILDIR is set; returns whether it started. */
export function startRelayBounceIntake(): boolean {
	const dir = relayBounceMaildir();
	if (!dir) return false;
	if (intake) return true;
	const controller = new AbortController();
	const intakeAddress = imapConfig()?.intakeAddress ?? "";
	const loop = (async () => {
		while (!controller.signal.aborted) {
			try {
				await ingestMaildir(dir, intakeAddress);
			} catch (error) {
				console.error("Relay bounce intake failed:", error);
			}
			await sleep(POLL_MS, controller.signal);
		}
	})();
	intake = { controller, loop };
	return true;
}

export async function stopRelayBounceIntake(): Promise<void> {
	intake?.controller.abort();
	await intake?.loop;
	intake = undefined;
}
