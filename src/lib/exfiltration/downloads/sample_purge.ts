import { lstat, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { isSampleExpired } from "./retention";

/** Only archives named by a lowercase SHA-256 under a two-character fan-out directory are ever removed. */
const ARCHIVE_NAME = /^[a-f0-9]{64}\.zip$/;
const FANOUT_DIRECTORY = /^[a-f0-9]{2}$/;

export type PurgeResult = { removed: number; kept: number; skipped: number };

/**
 * Delete sample archives whose retention window has fully elapsed. The walk is
 * bounded to the store root: it never follows a symbolic link, never leaves the
 * fan-out layout, and removes only files whose name is a SHA-256 archive, so an
 * unexpected file under the root is left untouched and counted as skipped.
 */
export async function purgeExpiredSamples(params: {
	root: string;
	now: Date;
	retentionMs: number;
}): Promise<PurgeResult> {
	if (!path.isAbsolute(params.root)) throw new Error("The sample store root must be an absolute path.");
	const result: PurgeResult = { removed: 0, kept: 0, skipped: 0 };
	let fanouts: string[];
	try {
		fanouts = await readdir(params.root);
	} catch (error) {
		// A store that has never been written to has nothing to purge.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
		throw error;
	}
	for (const fanout of fanouts) {
		if (!FANOUT_DIRECTORY.test(fanout)) {
			result.skipped += 1;
			continue;
		}
		const directory = path.join(params.root, fanout);
		const directoryStat = await lstat(directory);
		if (!directoryStat.isDirectory()) {
			result.skipped += 1;
			continue;
		}
		for (const name of await readdir(directory)) {
			const file = path.join(directory, name);
			if (!ARCHIVE_NAME.test(name)) {
				result.skipped += 1;
				continue;
			}
			const entry = await lstat(file);
			// A symbolic link or other non-file entry is never followed or deleted through.
			if (!entry.isFile()) {
				result.skipped += 1;
				continue;
			}
			// The stored time is the file's birth time, which is when the sample was kept.
			const storedAt = (await stat(file)).birthtime;
			if (isSampleExpired(storedAt, params.now, params.retentionMs)) {
				await rm(file, { force: true });
				result.removed += 1;
			} else {
				result.kept += 1;
			}
		}
	}
	return result;
}
