import { describe, expect, test } from "bun:test";

import { ProviderSubmissionNeedsHumanError, ProviderSubmissionRejectedError } from "../submission_contracts";
import { AlibabaConsoleError, AlibabaNeedLoginError, readConsoleAnswer, withAlibabaConsole } from "./api";
import { consoleRefusal, consoleSuccess, fakeConsoleFetch, freshSession, loginConfig, MISSING_PAGE, NEED_LOGIN, OSS_HOST, session, SUCCESS_ENV_SG, UPLOAD_POLICY } from "./test_support";
import { type FetchLike } from "../../../http/fetch";

describe("readConsoleAnswer", () => {
	test("returns the inner Data of the console's success envelope, including falsy values", () => {
		expect(readConsoleAnswer("GetUserIdArea", 200, SUCCESS_ENV_SG)).toEqual({ Env: "sg" });
		expect(readConsoleAnswer("GetCrossRegionExist", 200, consoleSuccess(false))).toBe(false);
		expect(readConsoleAnswer("ReportTaskList", 200, consoleSuccess({ PageSize: 20, Total: 0, List: [], Page: 1 }))).toEqual({ PageSize: 20, Total: 0, List: [], Page: 1 });
		// An envelope without an inner Code is a success only with Success:true.
		expect(readConsoleAnswer("X", 200, `{"code":"200","data":{"Data":"abc","Success":true}}`)).toBe("abc");
	});

	test("a 200 without Success:true is never a success, whatever else it carries", () => {
		for (const body of [`{"code":"200","data":{"Data":"abc"}}`, `{"code":"200","data":{"Data":"abc","Success":"true"}}`, `{"code":"200","data":{"Code":"200","Success":false,"Data":1}}`, `{"code":"200","data":{"Code":"500","Success":true,"Data":1}}`]) {
			let caught: unknown;
			try {
				readConsoleAnswer("X", 200, body);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(Error);
			expect(caught).not.toBeInstanceOf(ProviderSubmissionRejectedError);
		}
	});

	test("ConsoleNeedLogin, in the outer or the inner code, is the explicit login-expired signal", () => {
		expect(() => readConsoleAnswer("SubmitReportTask", 200, NEED_LOGIN)).toThrow(AlibabaNeedLoginError);
		expect(() => readConsoleAnswer("SubmitReportTask", 200, `{"code":"200","data":{"Code":"ConsoleNeedLogin","Success":false}}`)).toThrow(AlibabaNeedLoginError);
		// Not a rejection: nothing was filed and the work may run again.
		try {
			readConsoleAnswer("SubmitReportTask", 200, NEED_LOGIN);
		} catch (error) {
			expect(error).not.toBeInstanceOf(ProviderSubmissionRejectedError);
			expect((error as AlibabaNeedLoginError).action).toBe("SubmitReportTask");
		}
	});

	test("a named refusal is an AlibabaConsoleError, a ProviderSubmissionRejectedError, carrying code and message", () => {
		let caught: unknown;
		try {
			readConsoleAnswer("ReportTaskList", 400, MISSING_PAGE);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(AlibabaConsoleError);
		expect(caught).toBeInstanceOf(ProviderSubmissionRejectedError);
		expect(caught).toMatchObject({ name: "AlibabaConsoleError", action: "ReportTaskList", code: "MissingPage" });
		expect((caught as Error).message).toBe("Alibaba Cloud ReportTaskList refused: MissingPage (The parameter Page is missing from the request.)");
		// No message: no empty parentheses.
		expect(() => readConsoleAnswer("A", 400, consoleRefusal("NoPermission"))).toThrow("Alibaba Cloud A refused: NoPermission");
		expect(() => readConsoleAnswer("A", 400, consoleRefusal("NoPermission"))).not.toThrow("(");
	});

	test("an inner failure code under an outer 200 is a refusal named by the inner code and message", () => {
		const body = `{"code":"200","data":{"Code":"ReportDuplicated","Message":"already reported","Success":false}}`;
		expect(() => readConsoleAnswer("SubmitReportTask", 200, body)).toThrow(AlibabaConsoleError);
		expect(() => readConsoleAnswer("SubmitReportTask", 200, body)).toThrow("ReportDuplicated (already reported)");
		// Success:false with both codes 200 names nothing: ambiguous, never a success or a refusal.
		const unnamed = `{"code":"200","data":{"Code":"200","Success":false,"Message":"no"}}`;
		expect(() => readConsoleAnswer("SubmitReportTask", 200, unnamed)).toThrow("gave no usable answer");
		expect(() => readConsoleAnswer("SubmitReportTask", 200, unnamed)).not.toThrow(AlibabaConsoleError);
		// An inner code without Success:false is not a refusal either.
		expect(() => readConsoleAnswer("A", 200, `{"code":"200","data":{"Code":"ReportDuplicated"}}`)).not.toThrow(AlibabaConsoleError);
	});

	test("an outer code refuses only when named, non-transient and 4xx by httpStatusCode, else by the HTTP status", () => {
		const body = (code: string, httpStatusCode?: string | number) => JSON.stringify({ code, ...(httpStatusCode === undefined ? {} : { httpStatusCode }), message: "m" });
		// JSON field wins; without it the HTTP status decides.
		expect(() => readConsoleAnswer("A", 200, body("NoPermission", "403"))).toThrow(AlibabaConsoleError);
		expect(() => readConsoleAnswer("A", 200, body("NoPermission", 403))).toThrow(AlibabaConsoleError);
		expect(() => readConsoleAnswer("A", 400, body("NoPermission"))).toThrow(AlibabaConsoleError);
		expect(() => readConsoleAnswer("A", 400, body("NoPermission", "500"))).not.toThrow(AlibabaConsoleError);
		expect(() => readConsoleAnswer("A", 500, body("NoPermission"))).not.toThrow(AlibabaConsoleError);
		expect(() => readConsoleAnswer("A", 200, body("NoPermission"))).not.toThrow(AlibabaConsoleError);
		expect(() => readConsoleAnswer("A", 200, body("NoPermission", "302"))).not.toThrow(AlibabaConsoleError);
		// Transient and numeric codes stay ambiguous even under 4xx.
		for (const code of ["Throttling.User", "ServiceUnavailable", "InternalError", "SystemBusy", "RequestTimeout", "FlowControl", "429", "400"]) {
			let caught: unknown;
			try {
				readConsoleAnswer("A", 400, body(code, "400"));
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(Error);
			expect(caught).not.toBeInstanceOf(ProviderSubmissionRejectedError);
		}
		// An inner transient code under Success:false is ambiguous too.
		expect(() => readConsoleAnswer("A", 200, `{"code":"200","data":{"Code":"Throttling","Success":false}}`)).not.toThrow(AlibabaConsoleError);
	});

	test("anything that is not a console answer stays an ambiguous plain Error", () => {
		for (const [status, body] of [[502, "<html>Bad Gateway</html>"], [200, ""], [200, "null"], [200, "[]"], [200, `"ok"`], [200, "{}"], [200, `{"message":"hello"}`], [200, `{"code":123}`]] as const) {
			let caught: unknown;
			try {
				readConsoleAnswer("SubmitReportTask", status, body);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(Error);
			expect(caught).not.toBeInstanceOf(ProviderSubmissionRejectedError);
			expect(caught).not.toBeInstanceOf(AlibabaNeedLoginError);
		}
		expect(() => readConsoleAnswer("A", 502, "<html>")).toThrow("answered HTTP 502 without JSON");
		expect(() => readConsoleAnswer("A", 200, "{}")).toThrow("gave no usable answer");
	});

	test("a success code without any data is not a confirmation", () => {
		let caught: unknown;
		try {
			readConsoleAnswer("SubmitReportTask", 200, `{"code":"200","successResponse":true}`);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect(caught).not.toBeInstanceOf(ProviderSubmissionRejectedError);
	});
});

describe("console requests", () => {
	test("posts the form-urlencoded call the browser sends, with the session cookies", async () => {
		const console = fakeConsoleFetch({ GetUserIdArea: SUCCESS_ENV_SG });
		const data = await withAlibabaConsole((api) => api.call("GetUserIdArea"), { fetch: console.fetch, config: loginConfig, getSession: async () => session });
		expect(data).toEqual({ Env: "sg" });
		const [request] = console.requests;
		expect(request).toMatchObject({ url: "https://report.alibabacloud.com/data/api.json?action=GetUserIdArea&product=abusereport", method: "POST" });
		expect(request!.headers).toMatchObject({
			cookie: "login_aliyunid_ticket=ticket-value; cna=cna-value",
			"content-type": "application/x-www-form-urlencoded",
			origin: "https://report.alibabacloud.com",
			referer: "https://report.alibabacloud.com/",
		});
		expect(Object.fromEntries(request!.body!)).toEqual({ product: "abusereport", action: "GetUserIdArea", sec_token: "Ak2GAMjWhLGnDwas6DsrS3", collina: "", region: "cn-hangzhou" });
	});

	test("params travel as one JSON field, escaped as form data", async () => {
		const console = fakeConsoleFetch({ GetCrossRegionExist: consoleSuccess(false) });
		const params = { reportDomainIp: "https://a.test/?x=1&y=2 z", pageType: "harmInfo", note: "ü\"\\" };
		await withAlibabaConsole((api) => api.call("GetCrossRegionExist", params), { fetch: console.fetch, config: loginConfig, getSession: async () => session });
		expect(console.requests[0]!.body!.get("params")).toBe(JSON.stringify(params));
		expect(console.requests[0]!.params).toEqual(params);
	});

	test("an action name is URL-encoded and a request abort signal is passed on", async () => {
		const seen: Array<{ url: string; signal?: AbortSignal | null }> = [];
		const fetch: FetchLike = async (url, init) => { seen.push({ url: String(url), signal: init?.signal }); return new Response(consoleSuccess(1)); };
		const controller = new AbortController();
		await withAlibabaConsole((api) => api.call("A&B"), { fetch, config: loginConfig, getSession: async () => session, signal: controller.signal });
		expect(seen[0]!.url).toBe("https://report.alibabacloud.com/data/api.json?action=A%26B&product=abusereport");
		expect(seen[0]!.signal).toBe(controller.signal);
	});
});

describe("withAlibabaConsole", () => {
	function sessions() {
		const calls: Array<{ expiredSession?: string }> = [];
		return {
			calls,
			getSession: (async (_config: unknown, options?: { expiredSession?: { id: string } }) => {
				calls.push({ expiredSession: options?.expiredSession?.id });
				return calls.length === 1 ? session : freshSession;
			}) as never,
		};
	}

	test("one ConsoleNeedLogin triggers exactly one relogin naming the expired session, then the work runs again with the fresh one", async () => {
		const login = sessions();
		const console = fakeConsoleFetch({ GetUserIdArea: [NEED_LOGIN, SUCCESS_ENV_SG] });
		const result = await withAlibabaConsole(async (api, used) => ({ data: await api.call("GetUserIdArea"), used: used.id }), { fetch: console.fetch, config: loginConfig, getSession: login.getSession });
		expect(result).toEqual({ data: { Env: "sg" }, used: "session-2" });
		expect(login.calls).toEqual([{ expiredSession: undefined }, { expiredSession: "session-1" }]);
		expect(console.requests.map((request) => request.body!.get("sec_token"))).toEqual(["Ak2GAMjWhLGnDwas6DsrS3", "FreshSecToken99"]);
		expect(console.requests[1]!.headers.cookie).toContain("ticket-value");
	});

	test("a second ConsoleNeedLogin needs a person, with no third login or call", async () => {
		const login = sessions();
		const console = fakeConsoleFetch({ GetUserIdArea: NEED_LOGIN });
		const caught: Error = await withAlibabaConsole((api) => api.call("GetUserIdArea"), { fetch: console.fetch, config: loginConfig, getSession: login.getSession }).catch((error: unknown) => error as Error) as Error;
		expect(caught).toBeInstanceOf(ProviderSubmissionNeedsHumanError);
		expect(caught).not.toBeInstanceOf(AlibabaNeedLoginError);
		expect(caught.message).toContain("freshly logged-in session (GetUserIdArea)");
		expect(login.calls).toHaveLength(2);
		expect(console.count("GetUserIdArea")).toBe(2);
	});

	test("other errors never log in again: refusals, ambiguous answers and network failures", async () => {
		for (const answer of [MISSING_PAGE, "<html>", new Error("socket closed")]) {
			const login = sessions();
			const console = fakeConsoleFetch({ A: [answer] });
			await expect(withAlibabaConsole((api) => api.call("A"), { fetch: console.fetch, config: loginConfig, getSession: login.getSession })).rejects.toBeInstanceOf(Error);
			expect(login.calls).toHaveLength(1);
			expect(console.count("A")).toBe(1);
		}
	});

	test("a supplied session is used for the first attempt instead of getSession", async () => {
		const login = sessions();
		const console = fakeConsoleFetch({ A: [SUCCESS_ENV_SG] });
		await withAlibabaConsole((api) => api.call("A"), { fetch: console.fetch, config: loginConfig, session, getSession: login.getSession });
		expect(login.calls).toHaveLength(0);
		expect(console.requests[0]!.body!.get("sec_token")).toBe(session.secToken);
	});

	test("a failed relogin needs a person and keeps the login's reason; an abort during it propagates as is", async () => {
		const console = fakeConsoleFetch({ A: [NEED_LOGIN] });
		let logins = 0;
		const caught: Error = await withAlibabaConsole((api) => api.call("A"), {
			fetch: console.fetch, config: loginConfig, session,
			getSession: (async () => { logins += 1; throw new Error("login refused"); }) as never,
		}).catch((error: unknown) => error as Error) as Error;
		expect(caught).toBeInstanceOf(ProviderSubmissionNeedsHumanError);
		expect(caught.message).toContain("login refused");
		expect(logins).toBe(1);
		expect(console.count("A")).toBe(1);

		const controller = new AbortController();
		const aborted = new Error("aborted");
		await expect(withAlibabaConsole((api) => api.call("A"), {
			fetch: fakeConsoleFetch({ A: [NEED_LOGIN] }).fetch, config: loginConfig, session, signal: controller.signal,
			getSession: (async () => { controller.abort(); throw aborted; }) as never,
		})).rejects.toBe(aborted);
	});

	test("missing credentials fail before any session or request", async () => {
		const saved = { email: process.env.ABUSE_ALIBABA_CLOUD_LOGIN_EMAIL, password: process.env.ABUSE_ALIBABA_CLOUD_LOGIN_PASSWORD };
		delete process.env.ABUSE_ALIBABA_CLOUD_LOGIN_EMAIL;
		delete process.env.ABUSE_ALIBABA_CLOUD_LOGIN_PASSWORD;
		try {
			let requested = false;
			await expect(withAlibabaConsole(async () => 1, { fetch: async () => { requested = true; return new Response(""); }, getSession: (async () => { requested = true; return session; }) as never })).rejects.toThrow("ABUSE_ALIBABA_CLOUD_LOGIN_EMAIL");
			expect(requested).toBeFalse();
		} finally {
			if (saved.email !== undefined) process.env.ABUSE_ALIBABA_CLOUD_LOGIN_EMAIL = saved.email;
			if (saved.password !== undefined) process.env.ABUSE_ALIBABA_CLOUD_LOGIN_PASSWORD = saved.password;
		}
	});
});

describe("evidence upload", () => {
	const file = { name: "proof.png", mimeType: "image/png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) };
	const run = (answers: Parameters<typeof fakeConsoleFetch>[0]) => {
		const console = fakeConsoleFetch(answers);
		return { console, result: withAlibabaConsole((api) => api.upload(file), { fetch: console.fetch, config: loginConfig, getSession: async () => session }) };
	};

	test("asks for a policy by file name, posts the fields in OSS order with the file last, and returns the object key", async () => {
		const { console, result } = run({ UploadFileByName: consoleSuccess(UPLOAD_POLICY) });
		await expect(result).resolves.toBe(UPLOAD_POLICY.Key);
		expect(console.requests[0]!.params).toEqual({ name: "proof.png" });
		const upload = console.requests[1]!;
		expect(upload).toMatchObject({ url: OSS_HOST, method: "POST" });
		const entries = [...upload.form!.entries()];
		expect(entries.map(([name]) => name)).toEqual(["Policy", "Key", "OSSAccessKeyId", "success_action_status", "Signature", "x-oss-security-token", "file"]);
		expect(Object.fromEntries(entries.slice(0, -1))).toEqual({
			Policy: UPLOAD_POLICY.Policy,
			Key: UPLOAD_POLICY.Key,
			OSSAccessKeyId: "STS.NTestAccessId",
			success_action_status: "200",
			Signature: UPLOAD_POLICY.Signature,
			"x-oss-security-token": "CAIS-token",
		});
		const sent = entries.at(-1)![1] as unknown as File;
		expect(sent.name).toBe("proof.png");
		expect(sent.type).toBe("image/png");
		expect(Buffer.from(await sent.arrayBuffer()).equals(file.bytes)).toBeTrue();
		// The storage bucket is not the console: no session cookie is sent to it.
		expect(upload.headers.cookie).toBeUndefined();
	});

	test("accepts a trailing slash on the host and refuses every other host before uploading anything", async () => {
		await expect(run({ UploadFileByName: consoleSuccess({ ...UPLOAD_POLICY, Host: `${OSS_HOST}/` }) }).result).resolves.toBe(UPLOAD_POLICY.Key);
		for (const host of ["https://evil.example.com", "http://bucket.oss-ap.aliyuncs.com", "https://bucket.aliyuncs.com.evil.example", "https://evil.example/.aliyuncs.com", "https://x.aliyuncs.com@evil.example", "https://bucket.aliyuncs.com:8443", "https://bucket.aliyuncs.com/path", "ftp://bucket.aliyuncs.com"]) {
			const { console, result } = run({ UploadFileByName: consoleSuccess({ ...UPLOAD_POLICY, Host: host }) });
			await expect(result).rejects.toThrow("unexpected storage host");
			expect(console.requests).toHaveLength(1);
		}
	});

	test("a policy lacking any field, or not an object, is unusable", async () => {
		for (const field of Object.keys(UPLOAD_POLICY)) {
			for (const bad of [undefined, "", 7]) {
				const policy: Record<string, unknown> = { ...UPLOAD_POLICY, [field]: bad };
				const { console, result } = run({ UploadFileByName: consoleSuccess(policy) });
				await expect(result).rejects.toThrow("no usable upload policy");
				expect(console.requests).toHaveLength(1);
			}
		}
		for (const data of [null, "policy", []]) await expect(run({ UploadFileByName: consoleSuccess(data) }).result).rejects.toThrow("no usable upload policy");
	});

	test("a non-2xx answer from the storage is an upload error carrying status and the <Code> only, never the body or key", async () => {
		const fetch: FetchLike = async (url) => url === OSS_HOST
			? new Response("<Error><Code>AccessDenied</Code><Message>secret</Message><OSSAccessKeyId>STS.NTestAccessId</OSSAccessKeyId></Error>", { status: 403 })
			: new Response(consoleSuccess(UPLOAD_POLICY));
		let caught: unknown;
		try {
			await withAlibabaConsole((api) => api.upload(file), { fetch, config: loginConfig, getSession: async () => session });
		} catch (error) {
			caught = error;
		}
		expect((caught as Error).message).toContain("HTTP 403");
		expect((caught as Error).message).toBe("Alibaba Cloud's evidence storage refused the upload with HTTP 403 (AccessDenied).");
		expect((caught as Error).message).not.toContain("STS.");
		expect((caught as Error).message).not.toContain(UPLOAD_POLICY.Key);
		// A body without a <Code> adds nothing.
		const bare: FetchLike = async (url) => url === OSS_HOST ? new Response("<html>nope</html>", { status: 502 }) : new Response(consoleSuccess(UPLOAD_POLICY));
		await expect(withAlibabaConsole((api) => api.upload(file), { fetch: bare, config: loginConfig, getSession: async () => session })).rejects.toThrow("HTTP 502.");
		// Storage errors are not provider rejections of a report.
		expect(caught).not.toBeInstanceOf(ProviderSubmissionRejectedError);
	});

	test("a console refusal of the policy request is a refusal; ConsoleNeedLogin there relogs in once", async () => {
		await expect(run({ UploadFileByName: MISSING_PAGE }).result).rejects.toBeInstanceOf(AlibabaConsoleError);
		const console = fakeConsoleFetch({ UploadFileByName: [NEED_LOGIN, consoleSuccess(UPLOAD_POLICY)] });
		let logins = 0;
		const key = await withAlibabaConsole((api) => api.upload(file), { fetch: console.fetch, config: loginConfig, getSession: (async () => (++logins === 1 ? session : freshSession)) as never });
		expect(key).toBe(UPLOAD_POLICY.Key);
		expect(logins).toBe(2);
	});
});
