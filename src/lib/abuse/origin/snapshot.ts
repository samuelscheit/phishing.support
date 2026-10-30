import { z } from "zod";

const certificateSchema = z.object({
	names: z.array(z.string().max(253)).max(100),
	notBefore: z.string().max(64),
	notAfter: z.string().max(64),
	issuer: z.string().max(500),
	fingerprint256: z.string().max(128),
}).strict();

export const originHostSnapshotSchema = z.object({
	kind: z.literal("cloudflare_origin_host"),
	version: z.literal(1),
	recipient: z.string().email().max(320),
	providerLabel: z.string().min(1).max(200),
	originalDomain: z.string().min(1).max(253),
	sourceMessageId: z.string().regex(/^\d{1,20}$/),
	cloudflareReportId: z.string().regex(/^[a-f0-9]{16}$/i).optional(),
	observedAt: z.string().datetime(),
	networks: z.array(z.object({
		asn: z.number().int().positive(),
		holder: z.string().min(1).max(200),
		prefixes: z.array(z.string().max(64)).max(2_048),
		discoverySources: z.array(z.string().max(80)).max(10),
	}).strict()).max(24),
	scan: z.object({
		addressesScanned: z.number().int().nonnegative(),
		totalAddresses: z.number().int().nonnegative(),
		truncated: z.boolean(),
		selectedPrefixes: z.array(z.object({ asn: z.number().int().positive(), prefix: z.string().max(64) }).strict()).max(65_536),
	}).strict(),
	servers: z.array(z.object({
		ip: z.string().max(64),
		asn: z.number().int().positive().optional(),
		prefix: z.string().max(64).optional(),
		certificate: certificateSchema,
	}).strict()).max(16),
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
		submissionId: z.string().regex(/^\d{1,20}$/),
	}).strict()).max(100),
	errors: z.array(z.string().max(500)).max(100),
}).strict();

export type OriginHostSnapshot = z.infer<typeof originHostSnapshotSchema>;

export function readOriginHostSnapshot(value: unknown): OriginHostSnapshot | undefined {
	const parsed = originHostSnapshotSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}
