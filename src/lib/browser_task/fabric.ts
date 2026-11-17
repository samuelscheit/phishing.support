import { acquireFabricCdpSession, type FabricEgress, type FabricScalar } from "../browser/fabric";
import { runTask, type BrowserTask, type ChatModel, type StepLog, type TaskResult } from "./agent";

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
}): Promise<TaskResult | undefined> {
	const session = await (params.acquire ?? acquireFabricCdpSession)(params.metadata, { egress: params.egress });
	let outcome: "release" | "cancel" = "cancel";
	try {
		if (!(await params.started(session.id))) {
			outcome = "release";
			return undefined;
		}
		const result = await runTask({
			cdpEndpoint: session.cdpEndpoint,
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
		await session[outcome]().catch(() => undefined);
	}
}
