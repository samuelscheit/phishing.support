/**
 * What every injectable `fetch` dependency looks like; the global `fetch` and
 * every test double fit it. Declared as a method so that a double written for
 * the strings its caller passes (`(url: string) => …`) is accepted too.
 */
export type FetchLike = { call(input: string | URL, init?: RequestInit): Promise<Response> }["call"];

/** A reply read as status and text only, for callers (a page's own `fetch`, a recorded answer) that cannot hand over a `Response`. */
export type AnswerFetch = { call(input: string | URL, init?: RequestInit): Promise<Pick<Response, "status" | "text">> }["call"];

type Fetcher<Answer> = { call(input: string | URL, init?: RequestInit): Promise<Answer> }["call"];

/** `headers` with `user-agent` set to `userAgent`, replacing any spelling of it, in the shape they came in. */
export function withUserAgent(headers: HeadersInit | undefined, userAgent: string): HeadersInit {
	if (headers instanceof Headers) {
		const copy = new Headers(headers);
		copy.set("user-agent", userAgent);
		return copy;
	}
	const isUserAgent = (name: string) => name.toLowerCase() === "user-agent";
	if (Array.isArray(headers)) return [...headers.filter(([name]) => !isUserAgent(name!)), ["user-agent", userAgent]];
	return { ...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !isUserAgent(name))), "user-agent": userAgent };
}

/**
 * The one way a server-side request to a third party says who it is: the
 * given `fetch` (a test double, or the global one looked up per call) with
 * every request carrying `userAgent`. Without it Bun sends `Bun/…`, which
 * gateways may deny before any handler runs (AWS did, with a bare 403). Pick
 * `browserUserAgent` for endpoints a provider's web page calls and
 * `serviceUserAgent` for APIs meant for programs (`network/service_identity`).
 */
export function fetchAs<Answer = Response>(userAgent: string, fetchImplementation?: Fetcher<Answer>): Fetcher<Answer> {
	return (input, init) => (fetchImplementation ?? (globalThis.fetch as unknown as Fetcher<Answer>))(input, { ...init, headers: withUserAgent(init?.headers, userAgent) });
}
