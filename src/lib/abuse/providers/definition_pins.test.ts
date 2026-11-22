import { expect, test } from "bun:test";

import { GENERIC_PROVIDER_FORM_ADAPTER } from "./generic_form";
import { listProviderSubmissionProviders } from "./submission_registry_default";

/**
 * A changed definition literal changes its hash and sends every queued route
 * of that provider to needs_human. Update a pin here only together with a
 * deliberate version bump of that provider's definition.
 */
const PINS: Record<string, string[]> = {
	cloudflare: ["2026-10-23.1", "41d1dde22e001f91f654927933bf6065055e7d5774d6b3b63c904b0d9072f47a"],
	tencent: ["2026-11-22.1", "0f485f523b3d98b18b978544b102de8c09e4ccba7f41e58c48d1f9a66d4c86b5"],
	alibaba_cloud: ["2026-11-20.1", "fadb0b6084ef6d0149ee261bd5dafb63432418189441d5e26d400615a9ccc77e"],
	aws_trust_safety: ["2026-11-22.1", "b0482ac8e0ef6c2334532277b8539c085a4dd804ea1e0153fd63a387dfdcb55d"],
	microsoft_msrc: ["2026-11-20.2", "30ebeaf8ab3f9eeae88192f4a6ae24c81ef47f176c65bca1faeb73c575834c14"],
	namesilo: ["2026-11-22.1", "7365c13c8815295462e94285310c395a9ef9ea12dda224e1a07febbf84856564"],
	eranet: ["2026-11-07.1", "e1c85b4278faf4928328b12f7102d522ea94b53764a840a898ac0e487ceed8cc"],
	gname: ["2026-11-22.1", "20ed58ad03f12e28f7745b2344ca7d8560577b1cb23d90632d358e3cba636873"],
	google_cloud: ["2026-11-22.1", "100ff58624a5f3b16158dbacc7fb3f65434c090ac52c5d3aba97764ac89cdc59"],
	netcraft: ["2026-10-27.1", "3618822d9297a7da2fb09086671e4d5acdbabc85ca9252e32550097b7f10b6a4"],
	netcraft_mail: ["2026-10-26.1", "6447fbe9cc2f7877c48380ec1a89bf0d711d1d7abe786e9096c9586452ec10aa"],
	discord_webhook: ["2026-11-14.1", "483391dba93ac6a9308cde188ceb77ce7a8f55e121ad1eaab9de0e13f625e44e"],
	discord_dsa: ["2026-11-14.1", "f35e9e621d5064786b95b2a78917e008294b005aa71b894c8ddd1b1d2d9451e9"],
	tucows_bullwark: ["2026-11-22.1", "0a4523c6dfcaec37cde415d7fbdabb0423d2dbdaaf34e084a1b3d2b2230ab6c8"],
	publicdomainregistry: ["2026-11-21.1", "0f1b88601b1e98d8774498ba88dc8d7c1f9c7c125b80c91e39e7ed2947929762"],
	newfold: ["2026-11-22.1", "2776adb5e66f34c0eeeefaa45c187e04d662f5feff72908c0f3033480132f0dd"],
	godaddy: ["2026-11-21.1", "195cf22a168ba2b73c147fb1468fdc9e622ea09e0b5046c1ae333f988f98901f"],
	name_com: ["2026-11-21.1", "2aa129c1f1aac53bf5402c05313fb24dc0ff20628976fd984163f046f06b0ebc"],
	dynadot: ["2026-11-21.1", "93d6034d8661a729f7ffdda67cb4d2152f37194fd29d7f937b95a635b61bc960"],
	digitalocean: ["2026-11-22.1", "9a6126f037cc07fe983d64f106c3c4efdf757a3cb82281fc43c1366126fbcc83"],
};

test("every provider definition keeps its pinned version and content hash", () => {
	const actual = Object.fromEntries(listProviderSubmissionProviders().map(({ definition }) => [definition.key, [definition.version, definition.contentHash]]));
	expect(actual).toEqual(PINS);
});

test("the generic form adapter keeps its pinned hash", () => {
	expect([GENERIC_PROVIDER_FORM_ADAPTER.version, GENERIC_PROVIDER_FORM_ADAPTER.contentHash]).toEqual(["2026-11-23.1", "fd60afcb3fe42b4b37072d4e8f3e0a687916d3214966ae9e52363eb8b8c3748c"]);
});
