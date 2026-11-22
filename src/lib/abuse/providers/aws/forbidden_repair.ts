import { AbuseRepository } from "../../repository";
import { fallBackToEmail } from "../email_fallback";
import type { ProviderSubmissionProvider } from "../submission_contracts";
import { awsProvider } from "./index";
import { API_GATEWAY_FORBIDDEN_BODY, apiGatewayDenial } from "./submission";

/** The failure the code before API Gateway denials were refusals stored for them. */
export const AWS_FORBIDDEN_FAILURE = `AWS answered the report with HTTP 403: ${API_GATEWAY_FORBIDDEN_BODY}`;

/**
 * One-off repair (production 2026-11-20): AWS routes left in
 * `unknown_external_state` by API Gateway's 403 denial, which filed nothing,
 * settle as `provider_rejected` and go to the mailbox through the email
 * fallback. Only runs whose stored failure is exactly that denial are
 * touched; a rerun finds none left and changes nothing.
 * Run: `bun -e 'import { repairAwsForbiddenRoutes } from "./src/lib/abuse/providers/aws/forbidden_repair"; console.log(await repairAwsForbiddenRoutes())'`
 */
export async function repairAwsForbiddenRoutes(provider: ProviderSubmissionProvider = awsProvider): Promise<Array<{ routeId: string; fallbackRouteId?: string }>> {
	const repaired: Array<{ routeId: string; fallbackRouteId?: string }> = [];
	for (const { route, run } of await AbuseRepository.listUnresolvedProviderRuns([provider.definition.key])) {
		if (run.failureReason !== AWS_FORBIDDEN_FAILURE) continue;
		const settled = await AbuseRepository.reconcileProviderRunRejection({
			runId: run.id,
			providerRegistryKey: provider.definition.key,
			failureReason: apiGatewayDenial(API_GATEWAY_FORBIDDEN_BODY).message,
			reconciliationReason: "aws_api_gateway_denial",
		});
		if (!settled) continue;
		const fallback = await fallBackToEmail(provider, route.id, "provider_rejected");
		repaired.push({ routeId: route.id.toString(), ...(fallback ? { fallbackRouteId: fallback.toString() } : {}) });
	}
	return repaired;
}
