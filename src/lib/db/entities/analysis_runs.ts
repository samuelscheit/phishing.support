import { eq } from "drizzle-orm";
import { getDb } from "../index";
import { analysisRuns, type AnalysisRunKind } from "../schema";
import type { ResponseInputItem, ResponseOutputItem } from "openai/resources/responses/responses.mjs";
import { generateId } from "../ids";

const DATA_IMAGE = /^data:(image\/[\w.+-]+)[;,]/i;

function isInputImage(value: unknown): boolean {
    return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "input_image";
}

/**
 * A model input without the screenshots it carried: every `input_image` part,
 * at any depth, is dropped and an image inlined as a `data:image/…` URL
 * anywhere else is replaced by a note of its type. The screenshots are stored
 * as artifacts already; kept in the run, each would be megabytes of base64.
 */
export function stripInputImages<T>(input: T): T {
    if (typeof input === "string") {
        const image = DATA_IMAGE.exec(input);
        return (image ? `[${image[1]} omitted]` : input) as T;
    }
    if (Array.isArray(input)) return input.filter((item) => !isInputImage(item)).map(stripInputImages) as T;
    if (typeof input === "object" && input !== null) {
        return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, stripInputImages(value)])) as T;
    }
    return input;
}

export class AnalysisRunsEntity {
    static async create(submissionId: bigint, analysisKind: AnalysisRunKind, input?: Array<ResponseInputItem>) {
        const db = await getDb();
        const id = generateId();
        await db.insert(analysisRuns).values([
            {
                id,
                submissionId,
                status: "running" as const,
                analysisKind,
                input: stripInputImages(input),
                createdAt: new Date(),
            },
        ]);

        return id;
    }

    static async update(id: bigint, values: Partial<typeof analysisRuns.$inferInsert>) {
        const db = await getDb();
        await db.update(analysisRuns).set(values.input ? { ...values, input: stripInputImages(values.input) } : values).where(eq(analysisRuns.id, id));
    }

    static async listForSubmission(submissionId: bigint) {
        const db = await getDb();
        const result = await db
            .select()
            .from(analysisRuns)
            .orderBy(analysisRuns.createdAt)
            .where(eq(analysisRuns.submissionId, submissionId));

        // A run stored before its input was stripped on write is shown stripped too.
        return result.map((run) => ({ ...run, input: stripInputImages(run.input) }));
    }

    static async complete(runId: bigint, output?: Array<ResponseOutputItem>, tokensUsed?: number) {
        const db = await getDb();
        const result = await db
            .update(analysisRuns)
            .set({
                status: "completed",
                output: output,
                tokensUsed: tokensUsed,
            })
            .where(eq(analysisRuns.id, runId))
            .returning();

        console.log("Analysis run completed:", result);
    }

    static async fail(runId: bigint, data?: unknown) {
        const db = await getDb();
        await db.update(analysisRuns).set({ status: "failed", ...(data === undefined ? {} : { data }) }).where(eq(analysisRuns.id, runId));
    }
}
