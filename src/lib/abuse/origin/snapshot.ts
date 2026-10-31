import { z } from "zod";

export const certificateSchema = z.object({
	names: z.array(z.string().max(253)).max(100),
	notBefore: z.string().max(64),
	notAfter: z.string().max(64),
	issuer: z.string().max(500),
	fingerprint256: z.string().max(128),
}).strict();

export const originServerSchema = z.object({
	ip: z.string().max(64),
	asn: z.number().int().positive().optional(),
	prefix: z.string().max(64).optional(),
	certificate: certificateSchema,
}).strict();

export const originNetworkSchema = z.object({
	asn: z.number().int().positive(),
	holder: z.string().min(1).max(200),
	prefixes: z.array(z.string().max(64)).max(2_048),
	discoverySources: z.array(z.string().max(80)).max(10),
}).strict();

export const kitCollectedData = [
	"sign-in email or phone",
	"password",
	"one-time 2FA codes",
	"authenticator codes",
	"backup codes",
	"recovery email",
	"phone number",
	"payment card details",
	"identity details",
] as const;

export const originHostSnapshotSchema = z.object({
	kind: z.literal("cloudflare_origin_host"),
	version: z.literal(2),
	recipient: z.string().email().max(320),
	providerLabel: z.string().min(1).max(200),
	originalDomain: z.string().min(1).max(253),
	originalDomainRegisteredAt: z.string().datetime().optional(),
	sourceMessageId: z.string().regex(/^\d{1,20}$/),
	cloudflareReportId: z.string().regex(/^[a-f0-9]{16}$/i).optional(),
	observedAt: z.string().datetime(),
	networks: z.array(originNetworkSchema).max(24),
	scan: z.object({
		addressesScanned: z.number().int().nonnegative(),
		totalAddresses: z.number().int().nonnegative(),
		truncated: z.boolean(),
		selectedPrefixes: z.array(z.object({ asn: z.number().int().positive(), prefix: z.string().max(64) }).strict()).max(65_536),
		completedAt: z.string().datetime(),
	}).strict(),
	servers: z.array(originServerSchema).max(16),
	kit: z.object({
		phishingBasis: z.enum(["credential_theft", "payment_fraud", "malware_delivery"]).optional(),
		evidenceQuote: z.string().max(300).optional(),
		collects: z.array(z.enum(kitCollectedData)).max(kitCollectedData.length),
		exfiltrationProbed: z.boolean(),
		exfiltrationTargets: z.array(z.string().max(300)).max(20),
	}).strict(),
	fingerprints: z.array(z.object({
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
		mimeType: z.string().max(100),
		url: z.string().url().max(4_096),
		size: z.number().int().positive(),
	}).strict()).max(5),
	siblingCandidateCount: z.number().int().nonnegative().max(100),
	siblings: z.array(z.object({
		domain: z.string().max(253),
		url: z.string().url().max(4_096),
		matchingHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(5),
		originIp: z.string().max(64),
		certificate: certificateSchema,
		registeredAt: z.string().datetime().optional(),
		submissionId: z.string().regex(/^\d{1,20}$/),
	}).strict()).max(100),
	errors: z.array(z.string().max(500)).max(100),
}).strict();

export type OriginHostSnapshot = z.infer<typeof originHostSnapshotSchema>;
export type KitCollectedData = (typeof kitCollectedData)[number];

export function readOriginHostSnapshot(value: unknown): OriginHostSnapshot | undefined {
	const parsed = originHostSnapshotSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

/** Sweep state handed from one origin-host job slice to its successor. */
export const originSweepProgressSchema = z.object({
	networks: z.array(originNetworkSchema).max(24),
	offset: z.number().int().nonnegative(),
	servers: z.array(originServerSchema.omit({ asn: true, prefix: true })).max(16),
	errors: z.array(z.string().max(500)).max(100),
}).strict();

export type OriginSweepProgress = z.infer<typeof originSweepProgressSchema>;
