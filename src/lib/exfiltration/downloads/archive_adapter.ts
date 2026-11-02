import { writeProtectedArchive } from "./protected_archive";

/**
 * The positional builder the sample store expects, backed by the object-style
 * writer. Production code takes its builder only from here, so the store can
 * never be handed the raw object-style function, which would misbind arguments.
 */
export function buildSampleArchive(entryName: string, data: Buffer, password: string): Promise<Buffer> {
	return writeProtectedArchive({ entryName, data, password });
}
