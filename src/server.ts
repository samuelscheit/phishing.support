import next from "next";
import { createServer } from "node:http";

import { SubmissionsEntity } from "./lib/db/entities/submissions";
import { startWebsiteAutoRetries } from "./lib/submissions/website";
import { retryInterruptedWebsiteAnalysis } from "./lib/website/analysis/ai";
import { startAbuseWorker, stopAbuseWorker } from "./lib/abuse/worker";
import { startMailboxListener, stopMailboxListener } from "./lib/imap/listener";
import { startRelayBounceIntake, stopRelayBounceIntake } from "./lib/imap/maildir";

const dev = process.env.NODE_ENV !== "production";
const parsedPort = Number.parseInt(process.env.PORT ?? "", 10);
const port = parsedPort > 0 ? parsedPort : 3000;
const hostname = process.env.HOSTNAME ?? (dev ? "localhost" : "0.0.0.0");

const app = next({ dev, hostname, port, customServer: true });
const handler = app.getRequestHandler();

await app.prepare();

// If the process previously crashed/restarted, we may have submissions stuck in `running`.
// Mark them as failed; a website visit cut off this way is queued for the automatic retry.
try {
	const failed = await SubmissionsEntity.failAllRunning();
	for (const { id } of failed) await retryInterruptedWebsiteAnalysis(id);
	if (failed.length > 0) {
		console.warn(`Marked ${failed.length} running submissions as failed on startup; website visits are retried automatically.`);
	}
} catch (err) {
	console.error("Failed to mark running submissions as failed on startup:", err);
}

// A capture that failed because the browser service was down is retried on
// its own schedule rather than left failed.
const stopWebsiteAutoRetries = startWebsiteAutoRetries();

// The durable reporting worker files every confirmed report; the mailbox
// listener turns forwarded phishing mail into submissions and records provider
// replies. A misconfigured mailbox must not prevent the HTTP service from booting.
try {
	await startAbuseWorker();
	console.log("Reporting worker started.");
} catch (err) {
	console.error("Reporting worker failed to start:", err);
}
try {
	if (!startMailboxListener()) console.warn("IMAP is not configured; mail intake and provider replies are disabled.");
	if (!startRelayBounceIntake()) console.warn("RELAY_BOUNCE_MAILDIR is not set; bounces of reports are not read.");
} catch (err) {
	console.error("Mailbox listener failed to start:", err);
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
	stopWebsiteAutoRetries();
	await stopMailboxListener();
	await stopRelayBounceIntake();
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
