import { operatorHandler } from "@/lib/http/operator_handler";
import { listRetryHistory } from "@/lib/submissions/retry_history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every retry of a case, newest first, with the case before and now: the "Retried cases" view as data. */
export async function GET(request: Request) {
	return operatorHandler(request, async () => Response.json({ retries: await listRetryHistory() }, { headers: { "cache-control": "private, no-store" } }));
}
