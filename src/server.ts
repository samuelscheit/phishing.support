import next from "next";
import { createServer } from "node:http";

import { startImapListener } from "./lib/imap/imap_listener";
import { SubmissionsEntity } from "./lib/db/entities";
import { resumePendingWebsiteAnalyses } from "./lib/submissions/website";
import { startAbuseWorker, stopAbuseWorker } from "./lib/abuse/worker";
import { startAbuseImapListener, stopAbuseImapListener } from "./lib/abuse/imap";

function envInt(name: string, defaultValue: number): number {
	const raw = process.env[name];
	if (!raw) return defaultValue;
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) ? value : defaultValue;
}

const dev = process.env.NODE_ENV !== "production";
const port = envInt("PORT", 3000);
const hostname = process.env.HOSTNAME ?? (process.env.DOCKER ? "0.0.0.0" : "localhost");

const app = next({ dev, hostname, port, customServer: true });
const handler = app.getRequestHandler();

await app.prepare();

// If the process previously crashed/restarted, we may have submissions stuck in `running`.
// Mark them as failed so they can be retried or inspected.
try {
	const failed = await SubmissionsEntity.failAllRunning();
	if (failed.length > 0) {
		console.warn(`Marked ${failed.length} running submissions as failed on startup.`);
	}
} catch (err) {
	console.error("Failed to mark running submissions as failed on startup:", err);
}

// Versions before the bounded lookup worker left a short `new`-state crash
// window before they marked a website analysis running. Claim and resume only
// those legacy/new or retry-queued website rows; regular active work remains
// behind the explicit failed-analysis retry boundary above.
void resumePendingWebsiteAnalyses().then((resumed) => {
	if (resumed > 0) console.warn(`Resumed ${resumed} pending website analyses on startup.`);
}).catch((err) => console.error("Failed to resume pending website analyses on startup:", err));

// Start IMAP listener in the same process
startImapListener().catch((err) => {
	console.error("IMAP listener crashed:", err);
});

// Standalone abuse reporting has its own durable worker and optional mailbox
// bridge. Neither path touches the legacy submission/analysis tables.
try {
	await startAbuseWorker();
	await startAbuseImapListener();
	console.log("Standalone abuse worker started.");
} catch (err) {
	// A misconfigured optional mailbox must not prevent the HTTP service from
	// booting, but a worker startup failure is retained in logs for operations.
	console.error("Standalone abuse worker failed to start:", err);
}

const server = createServer((req, res) => {
	try {
		handler(req, res);
	} catch (err) {
		console.error("Request handler error:", err);
		res.statusCode = 500;
		res.end("Internal Server Error");
	}
});

const shutdown = async (signal: string) => {
	console.log(`Received ${signal}, shutting down...`);
	await stopAbuseImapListener();
	await stopAbuseWorker();
	server.close(() => {
		// no-op
	});
	try {
		// Next.js supports graceful shutdown
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await (app as any).close?.();
	} catch (err) {
		console.error("Error closing Next app:", err);
	}
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

server.listen(port, hostname, () => {
	console.log(`Server ready on http://${hostname}:${port} (dev=${dev})`);
});
