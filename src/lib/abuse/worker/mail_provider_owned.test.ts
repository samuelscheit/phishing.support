import { describe, expect, mock, test } from "bun:test";

mock.module("../mail/reply", () => ({
	...require("../mail/reply"),
	classifyProviderReply: async () => ({ classification: "not_monitored", confidence: 0.99, rationale: "Points to the abuse webform." }),
	extractVerifiedProviderLinks: async () => ["https://www.digitalocean.com/company/contact/abuse"],
}));

import { useTemporaryDatabase } from "../../db/test_helpers";
import { AbuseRepository } from "../repository";
import { emailRoute } from "../providers";
import { routeFixture } from "../providers/kit/testing";
import { classifyReply } from "./mail";

useTemporaryDatabase();

async function answeredRoute(email: string) {
	const { created, route: providerRoute } = await routeFixture({ mailbox: "abuse@provider.example", providerName: "Host" });
	const route = await AbuseRepository.upsertResolvedRoute(providerRoute.targetId, { ...emailRoute({ email, providerName: "Host", provenance: {}, snapshot: {} }), status: "awaiting_provider_reply" });
	const { id } = await AbuseRepository.persistInboundMailWithArtifacts({
		reportId: created.reportId, routeId: route.id, kind: "reply", fromAddress: email, toAddresses: ["support@phishing.support"], subject: "Re: abuse",
		textBody: "Use our form: https://www.digitalocean.com/company/contact/abuse", messageId: `<${email}-${route.id}@test>`,
		mailbox: "INBOX", uidValidity: 1, uid: Number(route.id % 1_000_000n) + 1, rawMime: { name: "reply.eml", buffer: Buffer.from("Subject: Re: abuse\r\n\r\nx") }, attachments: [],
	});
	return { route, messageId: id };
}

describe("a provider's \"use our form\" answer", () => {
	test("never starts the generic browser agent on a mailbox a reviewed provider owns", async () => {
		const { route, messageId } = await answeredRoute("abuse@digitalocean.com");
		await classifyReply(messageId);
		expect((await AbuseRepository.getRoute(route.id))?.status).toBe("awaiting_provider_reply");
	});

	test("still escalates any other mailbox to its verified form", async () => {
		const { route, messageId } = await answeredRoute("abuse@other-host.example");
		await classifyReply(messageId);
		expect((await AbuseRepository.getRoute(route.id))?.status).toBe("escalating_to_portal");
	});
});
