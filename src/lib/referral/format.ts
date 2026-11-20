import { formatUtcDateTime } from "../util/date_time";
/** Small text helpers shared by the German complaint mails and the English evidence archive. */

/** A timestamp as the English archive gives it: minutes, in UTC. */
export function utc(iso: string): string {
	return formatUtcDateTime(iso) ?? iso;
}

