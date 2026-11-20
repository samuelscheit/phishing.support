import { eq } from "drizzle-orm";
import { getDb } from "../index";
import { analysisRuns, type AnalysisRunKind } from "../schema";
import type { ResponseInputItem, ResponseOutputItem } from "openai/resources/responses/responses.mjs";
import { generateId } from "../ids";

/** A model input item without the screenshots it carried. */
function withoutInputImages(item: ResponseInputItem): ResponseInputItem {
    if (!("content" in item) || !Array.isArray(item.content)) return item;
    return { ...item, content: (item.content as Array<{ type?: string }>).filter((part) => part.type !== "input_image") } as ResponseInputItem;
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
                input: input,
                createdAt: new Date(),
            },
        ]);

        return id;
    }

    static async update(id: bigint, values: Partial<typeof analysisRuns.$inferInsert>) {
        const db = await getDb();
        await db.update(analysisRuns).set(values).where(eq(analysisRuns.id, id));
    }

    static async listForSubmission(submissionId: bigint) {
        const db = await getDb();
        const result = await db
            .select()
            .from(analysisRuns)
            .orderBy(analysisRuns.createdAt)
            .where(eq(analysisRuns.submissionId, submissionId));

        // Screenshots sent to the model are stored as artifacts already; the run list is shown without them.
        return result.map((run) => ({ ...run, input: run.input?.map(withoutInputImages) ?? run.input }));
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
