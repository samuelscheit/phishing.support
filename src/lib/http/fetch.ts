/**
 * What every injectable `fetch` dependency looks like; the global `fetch` and
 * every test double fit it. Declared as a method so that a double written for
 * the strings its caller passes (`(url: string) => …`) is accepted too.
 */
export type FetchLike = { call(input: string | URL, init?: RequestInit): Promise<Response> }["call"];

/** A reply read as status and text only, for callers (a page's own `fetch`, a recorded answer) that cannot hand over a `Response`. */
export type AnswerFetch = { call(input: string | URL, init?: RequestInit): Promise<Pick<Response, "status" | "text">> }["call"];
