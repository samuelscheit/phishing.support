import { describe, expect, test } from "bun:test";

import { createDossierToken, DossierLinkSecretMissingError, dossierDownloadUrl, verifyDossierToken } from "./download_link";

const env = { REFERRAL_LINK_SECRET: "x".repeat(40) };
const now = new Date("2026-11-17T10:00:00Z");

describe("dossier download link", () => {
	test("grants the campaign it names until it expires", () => {
		const { url, expiresAt } = dossierDownloadUrl(123n, now, env);
		expect(url.startsWith("https://phishing.support/api/dossier/123.")).toBe(true);
		expect(expiresAt.toISOString()).toBe("2027-11-17T10:00:00.000Z");
		const token = url.split("/").at(-1)!;
		expect(verifyDossierToken(token, now, env)).toBe(123n);
		expect(verifyDossierToken(token, new Date(expiresAt.getTime() - 1_000), env)).toBe(123n);
		expect(verifyDossierToken(token, expiresAt, env)).toBeUndefined();
	});

	test("refuses a token for another campaign, a changed expiry, another secret or garbage", () => {
		const token = createDossierToken(123n, new Date("2027-01-01T00:00:00Z"), env);
		const [, expires, signature] = token.split(".");
		expect(verifyDossierToken(`124.${expires}.${signature}`, now, env)).toBeUndefined();
		expect(verifyDossierToken(`123.${Number(expires) + 1}.${signature}`, now, env)).toBeUndefined();
		expect(verifyDossierToken(token, now, { REFERRAL_LINK_SECRET: "y".repeat(40) })).toBeUndefined();
		expect(verifyDossierToken("../../etc/passwd", now, env)).toBeUndefined();
		expect(verifyDossierToken(`${token}x`, now, env)).toBeUndefined();
	});

	test("cannot create or check a link without a strong secret", () => {
		expect(() => createDossierToken(1n, now, {})).toThrow(DossierLinkSecretMissingError);
		expect(() => createDossierToken(1n, now, { REFERRAL_LINK_SECRET: "short" })).toThrow(DossierLinkSecretMissingError);
	});
});
