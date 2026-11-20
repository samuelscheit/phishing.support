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
	tencent: ["2026-08-14.1", "bebdee41c9e34d50b1427ca8272a8e9ed4e397e8a729987123c152dd5d7a1abf"],
	alibaba_cloud: ["2026-11-20.1", "fadb0b6084ef6d0149ee261bd5dafb63432418189441d5e26d400615a9ccc77e"],
	aws_trust_safety: ["2026-11-20.2", "b559067d377d2337813c0e8c146523f7212d402b7315ac729c5d2cd6007f2651"],
	microsoft_msrc: ["2026-11-20.2", "30ebeaf8ab3f9eeae88192f4a6ae24c81ef47f176c65bca1faeb73c575834c14"],
	namesilo: ["2026-10-31.1", "3b0131ec634fea54bb82a2576bd544b095e58d6e0132b6360f41872df47f9cf9"],
	eranet: ["2026-11-07.1", "e1c85b4278faf4928328b12f7102d522ea94b53764a840a898ac0e487ceed8cc"],
	gname: ["2026-11-07.1", "7d419f7e57e0e212704a068013860515a58868f0d78391f9462d1f0b23db2ff2"],
	google_cloud: ["2026-11-20.1", "d4726dd96bbb1f57ff46035663937da8106f2400bf9f0097ba07e6eb32166316"],
	netcraft: ["2026-10-27.1", "3618822d9297a7da2fb09086671e4d5acdbabc85ca9252e32550097b7f10b6a4"],
	netcraft_mail: ["2026-10-26.1", "6447fbe9cc2f7877c48380ec1a89bf0d711d1d7abe786e9096c9586452ec10aa"],
	discord_webhook: ["2026-11-14.1", "483391dba93ac6a9308cde188ceb77ce7a8f55e121ad1eaab9de0e13f625e44e"],
	discord_dsa: ["2026-11-14.1", "f35e9e621d5064786b95b2a78917e008294b005aa71b894c8ddd1b1d2d9451e9"],
	tucows_bullwark: ["2026-11-20.1", "e121a9f5d33fd768ef5c2cd5cca82c047f50e29024688f5b513673d6e28f9187"],
	publicdomainregistry: ["2026-11-21.1", "0f1b88601b1e98d8774498ba88dc8d7c1f9c7c125b80c91e39e7ed2947929762"],
	newfold: ["2026-11-21.1", "ef635108d75eda9b015b9b105ea131b66c9fcd1f7593bc5478c070cbd7fb7463"],
	godaddy: ["2026-11-21.1", "195cf22a168ba2b73c147fb1468fdc9e622ea09e0b5046c1ae333f988f98901f"],
	name_com: ["2026-11-21.1", "2aa129c1f1aac53bf5402c05313fb24dc0ff20628976fd984163f046f06b0ebc"],
	dynadot: ["2026-11-21.1", "93d6034d8661a729f7ffdda67cb4d2152f37194fd29d7f937b95a635b61bc960"],
};

test("every provider definition keeps its pinned version and content hash", () => {
	const actual = Object.fromEntries(listProviderSubmissionProviders().map(({ definition }) => [definition.key, [definition.version, definition.contentHash]]));
	expect(actual).toEqual(PINS);
});

test("the generic form adapter keeps its pinned hash", () => {
	expect([GENERIC_PROVIDER_FORM_ADAPTER.version, GENERIC_PROVIDER_FORM_ADAPTER.contentHash]).toEqual(["2026-11-17.1", "368b62e0895f64f6d926cfc7367ee47c85752c091953c03ead6c23e2ffdaa092"]);
});
