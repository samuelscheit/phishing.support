import { isOperatorAuthorization, operatorChallenge } from "../operator_auth";
import { errorText } from "../error_text";
import { ComplainantNotConfiguredError } from "./complainant";
import { ReferralError } from "./service";

export function parseId(value: string): bigint | undefined {
	return /^\d{1,20}$/.test(value) ? BigInt(value) : undefined;
}

/**
 * Run an operator API handler: the login is checked again here (the proxy is
 * only the first gate), and a refused referral action becomes a 409 whose
 * message the page shows as it is.
 */
export async function operatorHandler(request: Request, handler: () => Promise<Response>): Promise<Response> {
	if (!isOperatorAuthorization(request.headers.get("authorization"))) return operatorChallenge();
	try {
		return await handler();
	} catch (error) {
		if (error instanceof ReferralError || error instanceof ComplainantNotConfiguredError) {
			return Response.json({ error: error.message }, { status: 409 });
		}
		console.error("Operator action failed:", error);
		return Response.json({ error: errorText(error) }, { status: 500 });
	}
}

export function zipResponse(body: ReadableStream<Uint8Array>, filename: string): Response {
	return new Response(body, {
		headers: {
			"content-type": "application/zip",
			"content-disposition": `attachment; filename="${filename.replace(/[\r\n"\\]/g, "_")}"`,
			"cache-control": "private, no-store",
			"x-content-type-options": "nosniff",
		},
	});
}
