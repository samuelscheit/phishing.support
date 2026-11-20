import { validateAbuseReportRequest } from "../../contracts";
import { AbuseRepository } from "../../repository";
import { contactRoute } from "../../resolver/routes";
import { providerSupplementalRoute } from "../submission_routes";
import { getProviderSubmissionProvider } from "../submission_registry_default";
import type { AbuseArtifact } from "../../schema";
import type { BrowserFormResponse } from "./browser_form";
import type { ProviderSubmissionContext, ProviderSubmissionPreflight, ProviderSubmissionPreparation } from "../submission_contracts";
import { sha256Hex } from "../../../util/hash";

/** Test support for the provider kit: fixtures every provider's tests share. */

export const TARGET = "login-example-phish.com";
export const DESCRIPTION = "The page asks visitors for a password, sign-in details, a verification code, or identity details.";
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

/** An original screenshot artifact as the report's evidence holds it: intact (digest and size of `bytes`) unless `overrides` break it. */
export const evidenceArtifact = (bytes: Buffer = PNG, overrides: Partial<AbuseArtifact> = {}): AbuseArtifact => ({
	id: 101n, reportId: 99n, targetId: null, routeId: null, runId: null, name: "website.png", kind: "user_evidence_original", mimeType: "image/png",
	sha256: sha256Hex(bytes), size: bytes.byteLength, metadata: {}, blob: bytes, createdAt: new Date(), ...overrides,
});

/** An intact original screenshot artifact. */
export const pngArtifact = (id: bigint, bytes = PNG, mimeType = "image/png") => evidenceArtifact(bytes, { id, reportId: 1n, name: "shot.png", mimeType });

/** A browser form's answer carrying JSON. */
export const formAnswer = (json: unknown, status = 200): BrowserFormResponse => ({ status, text: JSON.stringify(json), json });

/** An HTTP JSON answer. */
export const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export type RouteFixtureOptions = {
	/** The provider's abuse mailbox, which selects its definition; a supplemental provider (no mailbox) is named by its registry key instead. */
	mailbox: string | { supplemental: string };
	providerName: string;
	target?: string | undefined;
	allegationCategory?: "phishing" | "malware" | undefined;
	description?: string | undefined;
	observedUrls?: string[] | undefined;
	/** `null`: the report names no brand. */
	legalBrandUrl?: string | null | undefined;
	/** Bytes of an original screenshot saved with the report. */
	screenshot?: Buffer | undefined;
	provenance?: Record<string, unknown> | undefined;
};

/** A stored report with one target and a resolved route to the provider, in the temporary database. */
export async function routeFixture(options: RouteFixtureOptions) {
	const target = options.target ?? TARGET;
	const request = await validateAbuseReportRequest({
		targets: [target],
		allegationCategory: options.allegationCategory ?? "phishing",
		description: options.description ?? DESCRIPTION,
		observedUrls: [{ target, urls: options.observedUrls ?? [`https://${target}/signin`] }],
		...(options.legalBrandUrl === null ? {} : { legalBrandUrl: options.legalBrandUrl ?? "https://www.examplebank.com/" }),
	});
	const created = await AbuseRepository.createReport({ request, reporter: { reporterIp: "8.8.8.8" } });
	const [stored] = await AbuseRepository.listTargets(created.reportId);
	if (options.screenshot) await AbuseRepository.saveArtifact({ reportId: created.reportId, name: "website.png", kind: "user_evidence_original", mimeType: "image/png", buffer: options.screenshot });
	const input = typeof options.mailbox === "string"
		? contactRoute({ email: options.mailbox, providerName: options.providerName, provenance: options.provenance ?? {}, snapshot: {} })
		: providerSupplementalRoute({ provider: getProviderSubmissionProvider(options.mailbox.supplemental)!, source: { resolverProvenance: options.provenance ?? {}, resolutionSnapshot: {} } });
	const route = await AbuseRepository.upsertResolvedRoute(stored!.id, input);
	return { created, route, targetId: stored!.id };
}

/** A route fixture and the ready draft its provider prepared for it, read back as the executor would. */
export async function readyDraft<Payload>(
	options: RouteFixtureOptions,
	prepare: (context: ProviderSubmissionContext) => Promise<ProviderSubmissionPreparation>,
	read: (value: unknown) => Payload | undefined,
) {
	return readyDraftOf(await routeFixture(options), prepare, read);
}

/** The ready draft a provider prepared for a route of the caller's own making (an email or webhook report). */
export async function readyDraftOf<Payload, Fixture extends { route: { id: bigint } }>(
	fixture: Fixture,
	prepare: (context: ProviderSubmissionContext) => Promise<ProviderSubmissionPreparation>,
	read: (value: unknown) => Payload | undefined,
) {
	const preparation = await prepare({ routeId: fixture.route.id, payload: {} });
	if (preparation.outcome !== "ready") throw new Error(`expected ready, got ${JSON.stringify(preparation)}`);
	const payload = read(preparation.payload);
	if (!payload) throw new Error("expected a stored payload");
	return { ...fixture, payload, context: { routeId: fixture.route.id, payload: payload as unknown as Record<string, unknown> } };
}

/** A provider's preflight as the executor runs it: the draft is verified once, and the preflight receives that result. */
export function verifiedPrepare<Verified, Dependencies>(
	draft: { verify: (context: ProviderSubmissionContext, dependencies: never) => Promise<Verified> },
	prepare: (context: ProviderSubmissionContext, verified: Verified, dependencies: Dependencies) => Promise<ProviderSubmissionPreflight>,
) {
	return async (context: ProviderSubmissionContext, dependencies = {} as Dependencies) => prepare(context, await draft.verify(context, dependencies as never), dependencies);
}
