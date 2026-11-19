import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../index";
import { mailIngest, type MailIngestRoute } from "../schema";
import { generateId } from "../ids";

export class MailIngestEntity {
    static async get(params: { mailbox: string; uidValidity: number; uid: number }) {
        const db = await getDb();
        const [row] = await db
            .select()
            .from(mailIngest)
            .where(and(eq(mailIngest.mailbox, params.mailbox), eq(mailIngest.uidValidity, params.uidValidity), eq(mailIngest.uid, params.uid)));
        return row;
    }

    static async recordTerminal(params: {
        mailbox: string;
        uidValidity: number;
        uid: number;
        messageId?: string;
        route: Exclude<MailIngestRoute, "failed">;
        reason?: string;
    }) {
        const db = await getDb();
        const timestamp = new Date();
        await db
            .insert(mailIngest)
            .values([
                {
                    id: generateId(),
                    mailbox: params.mailbox,
                    uidValidity: params.uidValidity,
                    uid: params.uid,
                    messageId: params.messageId,
                    route: params.route,
                    reason: params.reason,
                    attempts: 1,
                    terminal: true,
                    processedAt: timestamp,
                    createdAt: timestamp,
                    updatedAt: timestamp,
                },
            ])
			.onConflictDoUpdate({
				target: [mailIngest.mailbox, mailIngest.uidValidity, mailIngest.uid],
				where: eq(mailIngest.terminal, false),
				set: {
					messageId: params.messageId,
					route: params.route,
					reason: params.reason,
					attempts: sql`${mailIngest.attempts} + 1`,
					terminal: true,
                    processedAt: timestamp,
                    updatedAt: timestamp,
                },
            });
    }

    static async recordFailure(params: { mailbox: string; uidValidity: number; uid: number; messageId?: string; reason: string }) {
        const db = await getDb();
        const timestamp = new Date();
        await db
            .insert(mailIngest)
            .values([
                {
                    id: generateId(),
                    mailbox: params.mailbox,
                    uidValidity: params.uidValidity,
                    uid: params.uid,
                    messageId: params.messageId,
                    route: "failed",
                    reason: params.reason,
                    attempts: 1,
                    terminal: false,
                    processedAt: timestamp,
                    createdAt: timestamp,
                    updatedAt: timestamp,
                },
            ])
			.onConflictDoUpdate({
				target: [mailIngest.mailbox, mailIngest.uidValidity, mailIngest.uid],
				where: eq(mailIngest.terminal, false),
				set: {
                    messageId: params.messageId,
                    route: "failed",
                    reason: params.reason,
                    attempts: sql`${mailIngest.attempts} + 1`,
                    terminal: false,
                    processedAt: timestamp,
                    updatedAt: timestamp,
                },
            });
    }
}
