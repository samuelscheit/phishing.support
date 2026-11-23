import { z } from "zod";

import type { AbuseMailAttachment } from "../mail/types";

/**
 * The facts of one funnel report: what the recipient gets as its
 * machine-readable evidence file, and what the mail to it is drafted from.
 * Written once when the report is created; the draft reads it back from the
 * report's evidence, so the mail states exactly what the evidence holds.
 */
export const FUNNEL_EVIDENCE_NAME = "funnel-evidence.json";

const identifier = z.object({ kind: z.string(), parameter: z.string(), value: z.string() });
const quote = z.object({ hopIndex: z.number().int(), url: z.string(), capturedAt: z.string(), quote: z.string() });

const funnelFactsSchema = z.object({
	kind: z.literal("deceptive_funnel"),
	submissionId: z.string(),
	party: z.object({
		role: z.enum(["merchant", "network"]),
		site: z.string(),
		platform: z.string().optional(),
		affiliateId: z.string().optional(),
	}),
	recordedAt: z.string(),
	deception: z.object({
		kind: z.string(),
		claim: z.string(),
		reality: z.string(),
		lureQuotes: z.array(quote).min(1),
		offerQuote: quote.optional(),
	}),
	merchant: z.object({ site: z.string(), url: z.string(), identifiers: z.array(identifier) }).optional(),
	affiliates: z.array(z.object({
		id: z.string(),
		site: z.string(),
		platform: z.string().optional(),
		parameter: z.string(),
		confidence: z.enum(["high", "medium", "low"]),
		matchedAt: z.array(z.string()),
	})),
	trackers: z.array(z.object({
		hopIndex: z.number().int(),
		site: z.string(),
		hostname: z.string(),
		url: z.string(),
		platform: z.string(),
		role: z.enum(["network", "affiliate_tracker"]),
		confidence: z.enum(["high", "medium", "low"]),
		signals: z.array(z.string()),
		identifiers: z.array(identifier),
		carriedBy: z.object({ parameter: z.string(), encoding: z.string() }).optional(),
	})),
	chain: z.array(z.object({
		index: z.number().int(),
		at: z.string().optional(),
		status: z.number().int().nullable(),
		url: z.string(),
		redirectTo: z.string().optional(),
		kind: z.enum(["tracker", "redirector", "lure", "merchant", "redirect"]),
	})),
	carriedValues: z.array(z.object({ value: z.string(), seenAt: z.array(z.object({ hopIndex: z.number().int(), site: z.string(), parameter: z.string() })) })),
	screenshots: z.array(z.object({ hopIndex: z.number().int(), url: z.string(), filename: z.string(), sha256: z.string(), capturedAt: z.string() })),
});

export type FunnelFacts = z.infer<typeof funnelFactsSchema>;

/** The facts among a report's evidence, or undefined when it holds none (or a corrupted copy). */
export function readFunnelFacts(evidence: readonly Pick<AbuseMailAttachment, "filename" | "content">[]): FunnelFacts | undefined {
	const file = evidence.find((attachment) => attachment.filename === FUNNEL_EVIDENCE_NAME);
	if (!file) return undefined;
	try {
		const parsed = funnelFactsSchema.safeParse(JSON.parse(file.content.toString("utf8")));
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
}
