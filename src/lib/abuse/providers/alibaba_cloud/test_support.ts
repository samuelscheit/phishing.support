import type { AlibabaFetch } from "./api";
import type { AlibabaCloudSession } from "./session";

/** Values captured from the live Alibaba console on 2026-11-20. */
export const SUCCESS_ENV_SG = `{"code":"200","data":{"Message":"successful","Data":{"Env":"sg"},"Code":"200","Success":true},"httpStatusCode":"200","requestId":"A1B2","successResponse":true}`;
export const MISSING_PAGE = `{"code":"MissingPage","httpStatusCode":"400","message":"The parameter Page is missing from the request.","requestId":"A1B2","successResponse":false}`;
export const NEED_LOGIN = `{"code":"ConsoleNeedLogin","httpStatusCode":"200","message":"need login","requestId":"A1B2","successResponse":false}`;
export const OSS_HOST = "https://trial-platform-sg-prod.oss-ap-southeast-1.aliyuncs.com";
export const UPLOAD_POLICY = {
	Policy: "eyJleHBpcmF0aW9uIjoiMjAyNiJ9",
	XOssSecurityToken: "CAIS-token",
	AccessId: "STS.NTestAccessId",
	Signature: "c2lnbmF0dXJl",
	Host: OSS_HOST,
	Key: "report/2026-11-20/proof.png/faa3c1d0",
};

export function consoleSuccess(data: unknown): string {
	return JSON.stringify({ code: "200", data: { Message: "successful", Data: data, Code: "200", Success: true }, httpStatusCode: "200", requestId: "A1B2", successResponse: true });
}

export function consoleRefusal(code: string, message = ""): string {
	return JSON.stringify({ code, httpStatusCode: "400", message, requestId: "A1B2", successResponse: false });
}

export const session: AlibabaCloudSession = {
	id: "session-1",
	expiresAt: Date.now() + 3_600_000,
	secToken: "Ak2GAMjWhLGnDwas6DsrS3",
	cookies: [
		{ name: "login_aliyunid_ticket", value: "ticket-value", domain: ".alibabacloud.com" },
		{ name: "cna", value: "cna-value", domain: ".alibabacloud.com" },
	],
};
export const freshSession: AlibabaCloudSession = { ...session, id: "session-2", secToken: "FreshSecToken99" };
export const loginConfig = { email: "support@phishing.support", password: "pw" };

export type RecordedRequest = { url: string; method: string; headers: Record<string, string>; action?: string; params?: unknown; form?: FormData; body?: URLSearchParams };

/**
 * A fake of the console and its OSS bucket. `answers` maps an action to the
 * body of each successive call (the last one repeats); a function receives the
 * parsed params. A `Response` is returned as is, an Error is thrown (network failure).
 */
export function fakeConsoleFetch(answers: Record<string, Array<string | Response | Error | ((params: unknown) => string)> | string>) {
	const requests: RecordedRequest[] = [];
	const counters = new Map<string, number>();
	const fetch: AlibabaFetch = async (url, init) => {
		const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
		const record: RecordedRequest = { url, method: init.method ?? "GET", headers };
		requests.push(record);
		if (init.body instanceof FormData) {
			record.form = init.body;
			return new Response("", { status: 200 });
		}
		const body = new URLSearchParams(String(init.body));
		record.body = body;
		record.action = body.get("action") ?? undefined;
		record.params = body.has("params") ? JSON.parse(body.get("params")!) : undefined;
		const entry = answers[record.action!];
		if (entry === undefined) throw new Error(`Unexpected console action ${record.action}`);
		const list = typeof entry === "string" ? [entry] : entry;
		const index = counters.get(record.action!) ?? 0;
		counters.set(record.action!, index + 1);
		const next = list[Math.min(index, list.length - 1)]!;
		if (next instanceof Error) throw next;
		if (next instanceof Response) return next;
		return new Response(typeof next === "function" ? next(record.params) : next, { status: 200 });
	};
	return { fetch, requests, actions: () => requests.filter((request) => request.action).map((request) => request.action!) , count: (action: string) => requests.filter((request) => request.action === action).length };
}
