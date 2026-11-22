import { acquireFabricCdpSession, type FabricEgress, type FabricScalar } from "../fabric";
import { runTask, type BrowserTask, type ChatModel, type StepLog, type TaskResult } from "./agent";
import { stageUploads, type BrowserTaskFile } from "./uploads";

export type FabricCdpSessionAcquirer = (
	metadata: Record<string, FabricScalar>,
	options: { egress: FabricEgress },
) => Promise<{ id: string; cdpEndpoint: string; release(): Promise<void>; cancel(): Promise<void> }>;

/**
 * Run one browser task on its own disposable Fabric browser.
 *
 * `started` is the caller's durable boundary: it receives the leased session
 * before the agent touches a page, and answering false (the work is no longer
 * eligible) releases the browser without running anything. A run that ends on
 * its own (whatever its status) releases the browser; an aborted or broken
 * run cancels it, because what the browser was doing is then unknown.
 *
 * `files` are the only files the agent may attach to a file input; without
 * them its upload tool is not offered. They are staged here and set in the
 * remote page by the task's own connection (see `stageUploads`).
 */
export async function runFabricBrowserTask(params: {
	task: BrowserTask;
	model: ChatModel;
	egress: FabricEgress;
	metadata: Record<string, FabricScalar>;
	timeoutMs: number;
	started(sessionId: string): Promise<boolean>;
	signal?: AbortSignal;
	onStep?: (step: StepLog) => void;
	acquire?: FabricCdpSessionAcquirer;
	files?: readonly BrowserTaskFile[];
}): Promise<TaskResult | undefined> {
	const uploads = params.files?.length ? await stageUploads(params.files) : undefined;
	let session: Awaited<ReturnType<FabricCdpSessionAcquirer>> | undefined;
	let connection: Awaited<ReturnType<NonNullable<typeof uploads>["connection"]>> | undefined;
	let outcome: "release" | "cancel" = "cancel";
	try {
		session = await (params.acquire ?? acquireFabricCdpSession)(params.metadata, { egress: params.egress });
		if (!(await params.started(session.id))) {
			outcome = "release";
			return undefined;
		}
		connection = uploads ? await uploads.connection(session.cdpEndpoint) : undefined;
		const result = await runTask({
			...(connection ? { connection } : { cdpEndpoint: session.cdpEndpoint }),
			...(uploads ? { uploadDirs: [uploads.directory] } : {}),
			goal: params.task.goal,
			...(params.task.startUrl ? { startUrl: params.task.startUrl } : {}),
			resultSchema: params.task.resultSchema,
			maxSteps: params.task.maxSteps,
			timeoutMs: params.timeoutMs,
			model: params.model,
			...(params.signal ? { signal: params.signal } : {}),
			...(params.onStep ? { onStep: params.onStep } : {}),
		});
		if (!params.signal?.aborted) outcome = "release";
		return result;
	} finally {
		connection?.close();
		await session?.[outcome]().catch(() => undefined);
		await uploads?.dispose();
	}
}
