import { userAgent } from "../../../network/service_identity";
import { asRecord, parseJsonRecord } from "../../../util/values";
import { snippet } from "../../../util/text";
import { ProviderSubmissionNeedsHumanError, ProviderSubmissionRejectedError } from "../submission_contracts";
import { ALIBABA_CLOUD_PROVIDER } from "./definition";
import { alibabaCloudLoginConfig, alibabaCloudSessions, type AlibabaCloudLoginConfig, type AlibabaCloudSession } from "./session";
import { type FetchLike } from "../../../http/fetch";

/** The console refused the call with a named error code (`MissingPage`, `NoPermission`). */
export class AlibabaConsoleError extends ProviderSubmissionRejectedError {
	constructor(readonly action: string, readonly code: string, message: string) {
		super(`Alibaba Cloud ${action} refused: ${code}${message ? ` (${message})` : ""}`);
		this.name = "AlibabaConsoleError";
	}
}

/** The session is no longer logged in: the console answered ConsoleNeedLogin. */
export class AlibabaNeedLoginError extends Error {
	constructor(readonly action: string) {
		super(`Alibaba Cloud ${action} needs a new login.`);
		this.name = "AlibabaNeedLoginError";
	}
}

export type AlibabaConsole = {
	/** Call one console action and return its `Data`; a refusal throws AlibabaConsoleError. */
	call(action: string, params?: Record<string, unknown>): Promise<unknown>;
	/** Store a file the way the form's upload does and return its `filePath`. */
	upload(file: { name: string; mimeType: string; bytes: Buffer }): Promise<string>;
};

function cookieHeader(session: AlibabaCloudSession): string {
	return session.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}



/** Codes that name a passing condition on Alibaba's side, never a refusal of the request itself. */
const TRANSIENT_CODE = /throttl|busy|unavailable|internal|timeout|flowcontrol|^\d+$/i;

/**
 * Read one console answer. Success is `{code:"200", data:{Code:"200",
 * Success:true, Data}}`. A refusal is a named client-side code: the console's
 * `{code:"MissingPage", httpStatusCode:"400", message}`, or a named code inside
 * a `data` that says `Success:false`. Anything else (numeric or throttling
 * codes, server errors, an HTML page) refuses nothing knowable: it stays
 * ambiguous, so a submission's own records settle it.
 */
export function readConsoleAnswer(action: string, status: number, body: string): unknown {
	const json = parseJsonRecord(body);
	if (!json) throw new Error(`Alibaba Cloud ${action} answered HTTP ${status} without JSON: ${snippet(body)}`);
	const data = asRecord(json.data);
	const code = typeof json.code === "string" ? json.code : undefined;
	const innerCode = typeof data?.Code === "string" ? data.Code : undefined;
	if (code === "ConsoleNeedLogin" || innerCode === "ConsoleNeedLogin") throw new AlibabaNeedLoginError(action);
	if (code === "200" && data?.Success === true && (innerCode === undefined || innerCode === "200")) return data.Data;
	const message = typeof data?.Message === "string" ? data.Message : typeof json.message === "string" ? json.message : "";
	const httpStatus = Number(typeof json.httpStatusCode === "string" || typeof json.httpStatusCode === "number" ? json.httpStatusCode : status);
	const outer = code && code !== "200" && httpStatus >= 400 && httpStatus < 500 ? code : undefined;
	const inner = innerCode && innerCode !== "200" && data?.Success === false ? innerCode : undefined;
	const refusal = inner ?? outer;
	if (refusal && !TRANSIENT_CODE.test(refusal)) throw new AlibabaConsoleError(action, refusal, message);
	throw new Error(`Alibaba Cloud ${action} gave no usable answer (HTTP ${status}): ${snippet(body)}`);
}

function sessionConsole(session: AlibabaCloudSession, request: FetchLike, signal?: AbortSignal): AlibabaConsole {
	const { consoleOrigin, apiProduct } = ALIBABA_CLOUD_PROVIDER;
	const headers = {
		cookie: cookieHeader(session),
		"user-agent": userAgent,
		accept: "application/json, text/plain, */*",
		"accept-language": "en-US,en;q=0.9",
		origin: consoleOrigin,
		referer: `${consoleOrigin}/`,
	};
	const call: AlibabaConsole["call"] = async (action, params) => {
		const body = new URLSearchParams({ product: apiProduct, action });
		if (params) body.set("params", JSON.stringify(params));
		body.set("sec_token", session.secToken);
		body.set("collina", "");
		body.set("region", "cn-hangzhou");
		const response = await request(`${consoleOrigin}/data/api.json?action=${encodeURIComponent(action)}&product=${apiProduct}`, {
			method: "POST",
			headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
			body,
			...(signal ? { signal } : {}),
		});
		return readConsoleAnswer(action, response.status, await response.text());
	};
	return {
		call,
		async upload(file) {
			const policy = asRecord(await call("UploadFileByName", { name: file.name }));
			const fields = policy && ["Host", "Key", "Policy", "AccessId", "Signature", "XOssSecurityToken"].map((name) => policy[name]);
			if (!policy || !fields!.every((value) => typeof value === "string" && value.length > 0)) {
				throw new Error("Alibaba Cloud UploadFileByName returned no usable upload policy.");
			}
			const [host, key, encodedPolicy, accessId, signature, token] = fields as string[];
			if (!/^https:\/\/[a-z0-9.-]+\.aliyuncs\.com\/?$/.test(host!)) throw new Error("Alibaba Cloud's upload policy names an unexpected storage host.");
			// OSS reads the form fields in order; the file must come last.
			const form = new FormData();
			form.set("Policy", encodedPolicy!);
			form.set("Key", key!);
			form.set("OSSAccessKeyId", accessId!);
			form.set("success_action_status", "200");
			form.set("Signature", signature!);
			form.set("x-oss-security-token", token!);
			form.set("file", new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }), file.name);
			const response = await request(host!, { method: "POST", body: form, headers: { origin: consoleOrigin, referer: `${consoleOrigin}/` }, ...(signal ? { signal } : {}) });
			if (!response.ok) {
				// OSS error documents echo the access key and signature: keep only the error code.
				const ossCode = /<Code>([^<]{1,80})<\/Code>/.exec(await response.text())?.[1];
				throw new Error(`Alibaba Cloud's evidence storage refused the upload with HTTP ${response.status}${ossCode ? ` (${ossCode})` : ""}.`);
			}
			return key!;
		},
	};
}

export type AlibabaConsoleDependencies = {
	fetch?: FetchLike;
	config?: AlibabaCloudLoginConfig;
	getSession?: typeof alibabaCloudSessions.get;
};

/**
 * Run `work` against the console with the account session. A session the
 * console no longer accepts is replaced by exactly one new login and the
 * work runs once more. That holds for the submission too: ConsoleNeedLogin is
 * the console's explicit refusal of the request, so nothing was filed. For
 * the same reason a fresh session that is refused too, or no fresh session at
 * all, is a known failure for a person, not an ambiguous one.
 */
export async function withAlibabaConsole<T>(
	work: (console: AlibabaConsole, session: AlibabaCloudSession) => Promise<T>,
	options: { signal?: AbortSignal; session?: AlibabaCloudSession } & AlibabaConsoleDependencies = {},
): Promise<T> {
	const config = options.config ?? alibabaCloudLoginConfig();
	const getSession = options.getSession ?? alibabaCloudSessions.get;
	const request = options.fetch ?? (globalThis.fetch as FetchLike);
	const session = options.session ?? await getSession(config, { ...(options.signal ? { signal: options.signal } : {}) });
	try {
		return await work(sessionConsole(session, request, options.signal), session);
	} catch (error) {
		if (!(error instanceof AlibabaNeedLoginError)) throw error;
	}
	let fresh: AlibabaCloudSession;
	try {
		fresh = await getSession(config, { expiredSession: session, ...(options.signal ? { signal: options.signal } : {}) });
	} catch (error) {
		if (options.signal?.aborted) throw error;
		throw new ProviderSubmissionNeedsHumanError(`Alibaba Cloud refused its session and no new login is available: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		return await work(sessionConsole(fresh, request, options.signal), fresh);
	} catch (error) {
		if (error instanceof AlibabaNeedLoginError) throw new ProviderSubmissionNeedsHumanError(`Alibaba Cloud refused a freshly logged-in session (${error.action}).`);
		throw error;
	}
}
