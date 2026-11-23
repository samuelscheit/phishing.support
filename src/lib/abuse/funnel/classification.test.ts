import { describe, expect, test } from "bun:test";

import type { AnalysisClient } from "../../analysis/run";
import { useTemporaryDatabase } from "../../db/test_helpers";
import { SubmissionsEntity } from "../../db/entities/submissions";
import { buildDeceptiveFunnelClassificationInput, classifyDeceptiveFunnel, DECEPTIVE_FUNNEL_FORMAT, validateDeceptiveFunnelClassification } from "./classification";
import { extractFunnel } from "./extract";
import { chainOf, CHECKOUT_TEXT, LURE_TEXT, productionChain } from "./test_fixtures";

useTemporaryDatabase();

const chain = productionChain();
const extraction = extractFunnel(chain);

function answer(overrides: Record<string, unknown> = {}) {
	return {
		finding: "deceptive_funnel",
		deceptionKind: "fake_application",
		lureClaim: "The visitor's application for financial assistance was pre-approved and needed one final step.",
		reality: "A $19.98 per month antivirus subscription checkout at zatos.com.",
		lureQuotes: [{ pageRef: "page-3", quote: "Your Financial Assist\nComplete the final step to submit your application." }],
		offerQuote: { pageRef: "page-8", quote: "$19.98/month" },
		...overrides,
	};
}

describe("validateDeceptiveFunnelClassification", () => {
	test("accepts quotes that are verbatim lure text, keeps the verbatim offer quote, and marks quoted line gaps", () => {
		expect(validateDeceptiveFunnelClassification(answer(), chain, extraction)).toEqual({
			finding: "deceptive_funnel",
			deceptionKind: "fake_application",
			lureClaim: "The visitor's application for financial assistance was pre-approved and needed one final step.",
			reality: "A $19.98 per month antivirus subscription checkout at zatos.com.",
			lureQuotes: [{ hopIndex: 3, url: chain.pages[0]!.url, quote: "Your Financial Assist … Complete the final step to submit your application." }],
			offerQuote: { hopIndex: 8, url: chain.pages[1]!.url, quote: "$19.98/month" },
		});
	});

	test("quotes match despite case, curly quotes and whitespace, as phishing quotes do", () => {
		const verdict = validateDeceptiveFunnelClassification(answer({ lureQuotes: [{ pageRef: "page-3", quote: "  application STATUS:   pre-approved " }] }), chain, extraction);
		expect(verdict).toMatchObject({ finding: "deceptive_funnel", lureQuotes: [{ quote: "application STATUS: pre-approved" }] });
	});

	test("a paraphrase is no evidence: the claim becomes insufficient_evidence with the reason", () => {
		expect(validateDeceptiveFunnelClassification(answer({ lureQuotes: [{ pageRef: "page-3", quote: "You have been approved for a government grant" }] }), chain, extraction)).toEqual({
			finding: "insufficient_evidence",
			rejectedClaim: `its evidence quote does not appear verbatim in the visible text of ${chain.pages[0]!.url}`,
		});
	});

	test("a quote from the merchant page or an unknown page cannot prove the lure", () => {
		expect(validateDeceptiveFunnelClassification(answer({ lureQuotes: [{ pageRef: "page-8", quote: "$19.98/month" }] }), chain, extraction)).toEqual({
			finding: "insufficient_evidence",
			rejectedClaim: "it quoted a page that is not the page it had to quote (\"page-8\")",
		});
		expect(validateDeceptiveFunnelClassification(answer({ lureQuotes: [] }), chain, extraction)).toEqual({ finding: "insufficient_evidence", rejectedClaim: "it quoted no lure page" });
	});

	test("one verbatim quote among rejected ones carries the verdict; duplicates and extra quotes are dropped", () => {
		const verdict = validateDeceptiveFunnelClassification(answer({
			lureQuotes: [
				{ pageRef: "page-3", quote: "invented text" },
				{ pageRef: "page-3", quote: "CONTINUE" },
				{ pageRef: "page-3", quote: "continue" },
				{ pageRef: "page-3", quote: "Your Financial Assist" },
				{ pageRef: "page-3", quote: "Application status: Pre-approved" },
				{ pageRef: "page-3", quote: "You are one step away from receiving your assistance." },
			],
		}), chain, extraction);
		expect(verdict.finding === "deceptive_funnel" && verdict.lureQuotes.map(({ quote }) => quote)).toEqual(["CONTINUE", "Your Financial Assist", "Application status: Pre-approved"]);
	});

	test("an offer quote that is not on the merchant page is dropped, not fatal", () => {
		const verdict = validateDeceptiveFunnelClassification(answer({ offerQuote: { pageRef: "page-8", quote: "Free forever" } }), chain, extraction);
		expect(verdict).toMatchObject({ finding: "deceptive_funnel" });
		expect("offerQuote" in verdict).toBeFalse();
		expect("offerQuote" in validateDeceptiveFunnelClassification(answer({ offerQuote: { pageRef: "", quote: "" } }), chain, extraction)).toBeFalse();
	});

	test("the model's sentences lose any URL and stay bounded", () => {
		const verdict = validateDeceptiveFunnelClassification(answer({ reality: `A subscription at https://www.zatos.com/special/av/ht/checkout.php for ${"very ".repeat(100)}much money.` }), chain, extraction);
		expect(verdict.finding === "deceptive_funnel" && verdict.reality).not.toContain("https://");
		expect(verdict.finding === "deceptive_funnel" && verdict.reality.length).toBeLessThanOrEqual(300);
		expect(validateDeceptiveFunnelClassification(answer({ lureClaim: "https://lure.example/" }), chain, extraction)).toEqual({ finding: "insufficient_evidence", rejectedClaim: "it did not say what the lure claimed and what the visitor got" });
	});

	test("an unknown deception kind, and a chain without a merchant, are not a deceptive funnel", () => {
		expect(validateDeceptiveFunnelClassification(answer({ deceptionKind: "none" }), chain, extraction)).toMatchObject({ finding: "insufficient_evidence", rejectedClaim: "it named no kind of misrepresentation" });
		const noMerchant = chainOf(["https://lure.example/a", "https://shop.example/b"], { 0: LURE_TEXT, 1: CHECKOUT_TEXT });
		expect(validateDeceptiveFunnelClassification(answer({ lureQuotes: [{ pageRef: "page-0", quote: "Your Financial Assist" }] }), noMerchant, extractFunnel(noMerchant))).toMatchObject({ finding: "insufficient_evidence", rejectedClaim: "the chain reached no merchant page through a tracking link" });
	});

	test("other findings pass through; a malformed answer throws so the run is retried", () => {
		expect(validateDeceptiveFunnelClassification(answer({ finding: "not_deceptive", lureQuotes: [] }), chain, extraction)).toEqual({ finding: "not_deceptive" });
		expect(validateDeceptiveFunnelClassification(answer({ finding: "insufficient_evidence", lureQuotes: [] }), chain, extraction)).toEqual({ finding: "insufficient_evidence" });
		expect(() => validateDeceptiveFunnelClassification(null, chain, extraction)).toThrow("invalid");
		expect(() => validateDeceptiveFunnelClassification(answer({ finding: "phishing" }), chain, extraction)).toThrow("invalid finding");
		expect(() => validateDeceptiveFunnelClassification(answer({ lureQuotes: "x" }), chain, extraction)).toThrow("lure quotes");
	});
});

describe("buildDeceptiveFunnelClassificationInput", () => {
	test("gives the model the lure and merchant pages with screenshots and the tracking links, nothing else", () => {
		const input = buildDeceptiveFunnelClassificationInput(chain, extraction);
		const [system, user] = input as Array<{ role: string; content: unknown }>;
		expect(system!.role).toBe("system");
		expect(String(system!.content)).toContain("verbatim");
		const parts = user!.content as Array<{ type: string; text?: string; image_url?: string }>;
		const texts = parts.filter((part) => part.type === "input_text").map((part) => part.text!).join("\n");
		expect(texts).toContain("page_ref: page-3");
		expect(texts).toContain("role: lure");
		expect(texts).toContain("page_ref: page-8");
		expect(texts).toContain("role: merchant");
		expect(texts).toContain(LURE_TEXT);
		expect(texts).toContain("a=15065");
		expect(texts).toContain("CAKE");
		expect(parts.filter((part) => part.type === "input_image").map((part) => part.image_url)).toEqual([
			`data:image/png;base64,${Buffer.from("lure-png").toString("base64")}`,
			`data:image/png;base64,${Buffer.from("checkout-png").toString("base64")}`,
		]);
		expect(DECEPTIVE_FUNNEL_FORMAT.schema?.required).toEqual(["finding", "deceptionKind", "lureClaim", "reality", "lureQuotes", "offerQuote"]);
	});

	test("refuses a chain without a lure page or merchant page", () => {
		const direct = chainOf(["https://miamitrk.com/?a=1&c=2", "https://shop.example/x"], { 1: CHECKOUT_TEXT });
		expect(() => buildDeceptiveFunnelClassificationInput(direct, extractFunnel(direct))).toThrow("needs a lure page");
	});
});

function scriptedModel(outputs: unknown[]): AnalysisClient & { calls: number } {
	const model = {
		calls: 0,
		responses: {
			create: async () => {
				const text = JSON.stringify(outputs[model.calls++]);
				return (async function* () {
					yield { type: "response.completed", response: { id: `response-${model.calls}`, status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { total_tokens: 10 } } };
				})();
			},
		},
	};
	return model as unknown as AnalysisClient & { calls: number };
}

describe("classifyDeceptiveFunnel", () => {
	async function submission(): Promise<bigint> {
		const url = "https://www.onlinesafetyall.com/6RNXHT/2HSS8TK/";
		return SubmissionsEntity.create({ kind: "website", data: { kind: "website", website: { url } }, dedupeKey: `website-${url}` });
	}

	test("asks the model once and returns the corroborated verdict with the extraction", async () => {
		const model = scriptedModel([answer()]);
		const { extraction: extracted, verdict } = await classifyDeceptiveFunnel({ submissionId: await submission(), chain }, { client: model });
		expect(model.calls).toBe(1);
		expect(extracted.merchant?.site).toBe("zatos.com");
		expect(verdict).toMatchObject({ finding: "deceptive_funnel", lureQuotes: [{ hopIndex: 3 }] });
	});

	test("a chain that cannot be a funnel is decided without the model", async () => {
		const model = scriptedModel([]);
		const noTracker = chainOf(["https://lure.example/a", "https://shop.example/b"], { 0: LURE_TEXT, 1: CHECKOUT_TEXT });
		expect((await classifyDeceptiveFunnel({ submissionId: 1n, chain: noTracker }, { client: model })).verdict).toEqual({ finding: "insufficient_evidence", rejectedClaim: "the chain reached no merchant page through a tracking link" });
		const noLure = chainOf(["https://miamitrk.com/?a=1&c=2", "https://shop.example/x"], { 1: CHECKOUT_TEXT });
		expect((await classifyDeceptiveFunnel({ submissionId: 1n, chain: noLure }, { client: model })).verdict).toEqual({ finding: "insufficient_evidence", rejectedClaim: "the chain showed no page before the merchant page" });
		expect(model.calls).toBe(0);
	});
});
