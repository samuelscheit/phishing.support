/** Small text helpers shared by the German complaint mails and the English evidence archive. */

/** A timestamp as the English archive gives it: minutes, in UTC. */
export function utc(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? iso : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

