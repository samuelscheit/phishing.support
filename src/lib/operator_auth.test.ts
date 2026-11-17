import { describe, expect, test } from "bun:test";

import { isOperatorAuthorization, operatorChallenge } from "./operator_auth";

const env = { OPERATOR_PASSWORD: "correct horse battery staple" };
const basic = (credentials: string) => `Basic ${Buffer.from(credentials).toString("base64")}`;

describe("operator login", () => {
	test("accepts the configured password with any user name", () => {
		expect(isOperatorAuthorization(basic("operator:correct horse battery staple"), env)).toBe(true);
		expect(isOperatorAuthorization(basic("samuel:correct horse battery staple"), env)).toBe(true);
	});

	test("refuses a wrong, missing or malformed credential", () => {
		expect(isOperatorAuthorization(basic("operator:correct horse battery stapl"), env)).toBe(false);
		expect(isOperatorAuthorization(basic("correct horse battery staple"), env)).toBe(false);
		expect(isOperatorAuthorization("Bearer correct horse battery staple", env)).toBe(false);
		expect(isOperatorAuthorization(undefined, env)).toBe(false);
	});

	test("lets nobody in without a strong configured password", () => {
		expect(isOperatorAuthorization(basic("operator:"), {})).toBe(false);
		expect(isOperatorAuthorization(basic("operator:short"), { OPERATOR_PASSWORD: "short" })).toBe(false);
	});

	test("asks the browser for the login", () => {
		const response = operatorChallenge();
		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toContain("Basic realm=");
	});
});
