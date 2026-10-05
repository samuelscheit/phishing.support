import { describe, expect, test } from "bun:test";

import type { FabricSkyvernTaskBinding } from "../../browser/fabric";
import type { AbuseSkyvernAdapter } from "./adapter";
import {
	createFabricSkyvernTask,
	FabricSkyvernTaskAmbiguityError,
} from "./fabric";

const payload = {
	prompt: "Use only the immutable report draft.",
	url: "https://provider.example.test/report",
	max_steps: 10,
	data_extraction_schema: { type: "object" },
} as const;

function binding() {
	let releases = 0;
	let cancellations = 0;
	const value: FabricSkyvernTaskBinding = {
		sessionId: "browser-session_skyvern-test",
		browserAddress: "ws://fabric-cdp-relay:8085/v1/cdp/browser-session_skyvern-test",
		release: async () => { releases += 1; },
		cancel: async () => { cancellations += 1; },
	};
	return {
		value,
		counts: () => ({ releases, cancellations }),
	};
}

function adapter(createTask: (binding: { browserAddress: string }) => Promise<{ runId: string }>): Pick<AbuseSkyvernAdapter, "createTask"> {
	return {
		createTask: async (_payload, taskBinding) => {
			if (!taskBinding) throw new Error("Fabric task binding was not supplied");
			const created = await createTask(taskBinding);
			return { ...created, response: { run_id: created.runId } };
		},
	};
}

describe("Fabric-bound Skyvern task creation", () => {
	test("releases the browser when the durable pre-call marker rejects creation", async () => {
		const lease = binding();
		const result = await createFabricSkyvernTask({
			adapter: adapter(async () => ({ runId: "task_unused" })),
			payload,
			metadata: { provider: "generic" },
			prepare: async () => false,
			record: async () => true,
			acquire: async () => lease.value,
		});

		expect(result).toEqual({ state: "not_eligible" });
		expect(lease.counts()).toEqual({ releases: 1, cancellations: 0 });
	});

	test("records only an opaque Fabric session ID and leaves a successful lease for reconciliation", async () => {
		const lease = binding();
		let recorded: { skyvernRunId: string; fabricSessionId: string } | undefined;
		const result = await createFabricSkyvernTask({
			adapter: adapter(async (taskBinding) => {
				expect(taskBinding.browserAddress).toBe("ws://fabric-cdp-relay:8085/v1/cdp/browser-session_skyvern-test");
				expect(taskBinding.browserAddress).not.toContain("cap=");
				return { runId: "task_created" };
			}),
			payload,
			metadata: { provider: "generic" },
			prepare: async () => true,
			record: async (value) => {
				recorded = value;
				return true;
			},
			acquire: async () => lease.value,
		});

		expect(result).toEqual({ state: "created", skyvernRunId: "task_created", fabricSessionId: "browser-session_skyvern-test" });
		expect(recorded).toEqual({ skyvernRunId: "task_created", fabricSessionId: "browser-session_skyvern-test" });
		expect(lease.counts()).toEqual({ releases: 0, cancellations: 0 });
	});

	test("cancels the Fabric browser when Skyvern task creation becomes ambiguous", async () => {
		const lease = binding();
		await expect(createFabricSkyvernTask({
			adapter: adapter(async () => { throw new Error("connection lost after task request"); }),
			payload,
			metadata: { provider: "generic" },
			prepare: async () => true,
			record: async () => true,
			acquire: async () => lease.value,
		})).rejects.toBeInstanceOf(FabricSkyvernTaskAmbiguityError);
		expect(lease.counts()).toEqual({ releases: 0, cancellations: 1 });
	});

	test("cancels the Fabric browser when the durable Skyvern response checkpoint conflicts", async () => {
		const lease = binding();
		const result = await createFabricSkyvernTask({
			adapter: adapter(async () => ({ runId: "task_unrecorded" })),
			payload,
			metadata: { provider: "generic" },
			prepare: async () => true,
			record: async () => false,
			acquire: async () => lease.value,
		});

		expect(result).toEqual({ state: "record_conflict", skyvernRunId: "task_unrecorded", fabricSessionId: "browser-session_skyvern-test" });
		expect(lease.counts()).toEqual({ releases: 0, cancellations: 1 });
	});
});
