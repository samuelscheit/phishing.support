import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { getDb } from "../../../db";
import { useTemporaryDatabase } from "../../../db/test_helpers";
import { validateAbuseReportRequest } from "../../contracts";
import { AbuseRepository } from "../../repository";
import { abuseJobs } from "../../schema";
import { sha256Hex } from "../../security";
import type { AbuseSkyvernAdapter } from "../../skyvern";
import { AbuseWorker } from "../../worker";
import { GNAME_PROVIDER } from "./definition";
import { gnameCodeLockKey, gnameCodeLockOwner } from "./mailbox";
import {
	beginGnameEvidenceUpload,
	beginGnamePortalExecution,
	requeueGnamePortalPreparation,
} from "./persistence/portal";

useTemporaryDatabase();

const environmentNames = [
	"ABUSE_GNAME_ENABLED",
	"ABUSE_GNAME_IDENTITY_VERIFIED",
	"ABUSE_GNAME_SERVICE_NAME",
	"ABUSE_GNAME_SERVICE_MAILBOX",
	"ABUSE_GNAME_UPLOAD_URL_MAX_AGE_MS",
	"ABUSE_GNAME_UPLOAD_URL_MIN_REMAINING_MS",
	"SKYVERN_INTERNAL_S3_ORIGIN",
] as const;
const originalEnvironment = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));

beforeEach(() => {
	process.env.ABUSE_GNAME_ENABLED = "true";
	process.env.ABUSE_GNAME_IDENTITY_VERIFIED = "true";
	process.env.ABUSE_GNAME_SERVICE_NAME = "Phishing Support";
	process.env.ABUSE_GNAME_SERVICE_MAILBOX = "gname-reports@phishing.support";
	process.env.ABUSE_GNAME_UPLOAD_URL_MAX_AGE_MS = "600000";
	process.env.ABUSE_GNAME_UPLOAD_URL_MIN_REMAINING_MS = "1000";
	delete process.env.SKYVERN_INTERNAL_S3_ORIGIN;
});

afterAll(() => {
	for (const name of environmentNames) {
		const value = originalEnvironment[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

async function createGnameRoute() {
	const request = await validateAbuseReportRequest({
		targets: ["example.com"],
		allegationCategory: "phishing",
		description: "A credential-harvesting page impersonates the protected brand.",
		observedUrls: [{ target: "example.com", urls: ["https://login.example.com/collect"] }],
		legalBrandUrl: "https://brand.example.com/",
	});
	const created = await AbuseRepository.createReport({ request, reporter: { reporterIp: "8.8.8.8" } });
	const [target] = await AbuseRepository.listTargets(created.reportId);
	if (!target) throw new Error("Test report did not create its target.");
	const route = await AbuseRepository.upsertResolvedRoute(target.id, {
		routeKey: GNAME_PROVIDER.key,
		providerRegistryKey: GNAME_PROVIDER.key,
		providerDisplayName: GNAME_PROVIDER.displayName,
		routeType: "skyvern_portal",
		providerDefinitionVersion: GNAME_PROVIDER.version,
		providerDefinitionHash: GNAME_PROVIDER.contentHash,
		resolverProvenance: { registrarId: 1923, match: "exact_iana_registrar_id" },
		resolutionSnapshot: { source: "test" },
		serviceIdentity: { name: "Phishing Support", mailbox: "gname-reports@phishing.support", verified: true },
		status: "queued",
	});
	const artifactId = await AbuseRepository.saveArtifact({
		reportId: created.reportId,
		targetId: target.id,
		routeId: route.id,
		name: "evidence-1.jpg",
		kind: "provider_evidence_derivative",
		mimeType: "image/jpeg",
		buffer: Buffer.from("durable provider screenshot bytes"),
	});
	const artifact = await AbuseRepository.getArtifact(created.reportId, artifactId);
	if (!artifact) throw new Error("Test evidence artifact was not retained.");
	return { ...created, target, route, artifact };
}

function gnameUploadDraft(params: {
	target: string;
	observedUrls: string[];
	artifact: { id: bigint; name: string; mimeType: string; sha256: string; size: number };
}) {
	return {
		adapter: "gname_category_2_v1",
		stage: "evidence_upload_pending",
		taskInput: {
			entryUrl: GNAME_PROVIDER.entryUrl,
			description: "Phishing report for example.com.",
			domains: [params.target],
			observedUrls: params.observedUrls,
			serviceName: "Phishing Support",
			legalBrandUrl: "https://brand.example.com/",
			serviceMailbox: "gname-reports@phishing.support",
			totpIdentifier: "gname-reports@phishing.support",
		},
		contract: {
			entryUrl: GNAME_PROVIDER.entryUrl,
			providerDefinitionVersion: GNAME_PROVIDER.version,
			providerDefinitionHash: GNAME_PROVIDER.contentHash,
			domains: [params.target],
			observedUrls: params.observedUrls,
			allowedFinalDomains: GNAME_PROVIDER.verifiedDomains,
			declarationContract: "gname_service_declaration_v1",
		},
		sourceArtifacts: [{
			id: params.artifact.id.toString(),
			name: params.artifact.name,
			mimeType: params.artifact.mimeType,
			sha256: params.artifact.sha256,
			size: params.artifact.size,
		}],
		evidenceUploads: [{
			artifactId: params.artifact.id.toString(),
			sha256: params.artifact.sha256,
			state: "pending",
		}],
	};
}

async function enqueuePortalRun(reportId: bigint, routeId: bigint, suffix: string): Promise<string> {
	const dedupeKey = `test-gname-portal:${routeId.toString()}:${suffix}`;
	await AbuseRepository.enqueueJob({
		jobType: "run_portal",
		reportId,
		routeId,
		payload: {},
		dedupeKey,
		nextAttemptAt: new Date(0),
	});
	return dedupeKey;
}

describe("GNAME portal durability", () => {
	test("records each evidence-upload pre-call boundary and refuses to replay an interrupted upload", async () => {
		const context = await createGnameRoute();
		const draft = gnameUploadDraft({ target: context.target.normalizedTarget, observedUrls: context.target.observedUrls, artifact: context.artifact });
		const execution = await beginGnamePortalExecution({
			routeId: context.route.id,
			correlationKey: `portal-run:${context.route.id.toString()}`,
			providerPayload: draft,
			lockKey: gnameCodeLockKey("gname-reports@phishing.support"),
			lockOwner: gnameCodeLockOwner(context.route.id),
			lockLeaseMs: 60_000,
		});
		expect(execution.acquired).toBeTrue();
		if (!execution.acquired) throw new Error("GNAME route did not acquire its mailbox lock.");
		expect(await beginGnameEvidenceUpload({
			runId: execution.run.id,
			artifactId: context.artifact.id.toString(),
			sha256: context.artifact.sha256,
		})).toBe("started");
		expect(await beginGnameEvidenceUpload({
			runId: execution.run.id,
			artifactId: context.artifact.id.toString(),
			sha256: context.artifact.sha256,
		})).toBe("already_started");
		expect(await requeueGnamePortalPreparation({ runId: execution.run.id, error: "simulated restart" })).toBeFalse();

		let uploads = 0;
		const worker = new AbuseWorker({
			adapter: {
				uploadFile: async () => {
					uploads += 1;
					return { presignedUrl: "https://storage.example.com/upload", sha256: context.artifact.sha256 };
				},
				createTask: async () => ({ runId: "should-not-be-created" }),
			} as unknown as AbuseSkyvernAdapter,
		});
		const dedupeKey = await enqueuePortalRun(context.reportId, context.route.id, "interrupted-upload");
		expect(await worker.processOne()).toBeTrue();
		expect(uploads).toBe(0);
		expect(await AbuseRepository.getProviderRun(execution.run.id)).toMatchObject({ executionStatus: "unknown_external_state" });
		expect(await AbuseRepository.getRoute(context.route.id)).toMatchObject({ status: "unknown_external_state" });
		const job = (await getDb()).select().from(abuseJobs).where(eq(abuseJobs.dedupeKey, dedupeKey)).get();
		expect(job).toMatchObject({ status: "unknown_external_state", unknownExternalState: true });
	});

	test("uses each checkpointed upload exactly once before creating the pinned task through normal worker dispatch", async () => {
		const context = await createGnameRoute();
		let uploads = 0;
		let taskCreations = 0;
		const worker = new AbuseWorker({
			adapter: {
				uploadFile: async ({ buffer }: { buffer: Buffer }) => {
					uploads += 1;
					return { presignedUrl: "https://storage.example.com/gname-evidence-1", sha256: sha256Hex(buffer) };
				},
				createTask: async () => {
					taskCreations += 1;
					return { runId: "gname-task-1" };
				},
			} as unknown as AbuseSkyvernAdapter,
		});
		await enqueuePortalRun(context.reportId, context.route.id, "first");
		expect(await worker.processOne()).toBeTrue();
		expect({ uploads, taskCreations }).toEqual({ uploads: 1, taskCreations: 1 });
		const run = await AbuseRepository.getLatestProviderRunForRoute(context.route.id);
		expect(run).toMatchObject({ skyvernRunId: "gname-task-1", executionStatus: "waiting_code" });
		const payload = run?.providerPayload as Record<string, unknown>;
		expect(payload.stage).toBe("task_payload_prepared");
		expect(payload.evidenceUploads).toEqual([
			expect.objectContaining({ artifactId: context.artifact.id.toString(), state: "uploaded", presignedUrl: "https://storage.example.com/gname-evidence-1" }),
		]);
		expect(await AbuseRepository.getRoute(context.route.id)).toMatchObject({ status: "waiting_code" });

		await enqueuePortalRun(context.reportId, context.route.id, "replay");
		expect(await worker.processOne()).toBeTrue();
		expect({ uploads, taskCreations }).toEqual({ uploads: 1, taskCreations: 1 });
	});
});
