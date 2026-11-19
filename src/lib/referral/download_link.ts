import { createHmac, timingSafeEqual } from "node:crypto";

import { serviceIdentity } from "../constants";
import { DAY_MS } from "../duration";

/**
 * A link an authority can open without an account to download a campaign's
 * evidence archive. It names the campaign and an expiry and is signed with
 * `REFERRAL_LINK_SECRET`; nothing else grants access to the archive.
 */
export const DOSSIER_LINK_DAYS = 365;

export class DossierLinkSecretMissingError extends Error {
	constructor() {
		super("REFERRAL_LINK_SECRET must be set (at least 32 characters) to give authorities a download link.");
		this.name = "DossierLinkSecretMissingError";
	}
}

function secret(env: Record<string, string | undefined>): string {
	const value = env.REFERRAL_LINK_SECRET;
	if (!value || value.length < 32) throw new DossierLinkSecretMissingError();
	return value;
}

function signature(payload: string, key: string): string {
	return createHmac("sha256", key).update(payload).digest("base64url");
}

export function createDossierToken(campaignId: bigint, expiresAt: Date, env: Record<string, string | undefined> = process.env): string {
	const payload = `${campaignId.toString()}.${Math.floor(expiresAt.getTime() / 1000)}`;
	return `${payload}.${signature(payload, secret(env))}`;
}

/** The campaign a token grants, or undefined when it is forged, malformed or expired. */
export function verifyDossierToken(token: string, now: Date = new Date(), env: Record<string, string | undefined> = process.env): bigint | undefined {
	const match = /^(\d{1,20})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
	if (!match) return undefined;
	const [, campaignId, expires, provided] = match;
	const expected = Buffer.from(signature(`${campaignId}.${expires}`, secret(env)));
	const given = Buffer.from(provided!);
	if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
	if (Number(expires) * 1000 <= now.getTime()) return undefined;
	return BigInt(campaignId!);
}

export function dossierDownloadUrl(campaignId: bigint, now: Date = new Date(), env: Record<string, string | undefined> = process.env): { url: string; expiresAt: Date } {
	const expiresAt = new Date(now.getTime() + DOSSIER_LINK_DAYS * DAY_MS);
	return { url: `${serviceIdentity.url}/api/dossier/${createDossierToken(campaignId, expiresAt, env)}`, expiresAt };
}
