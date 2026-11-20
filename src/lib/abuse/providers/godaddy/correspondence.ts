import type { AbuseMailClassification } from "../../schema";
import { isReportReference } from "../report_reference";
import type { ProviderCorrespondence } from "../submission_contracts";
import { fetchGoDaddyTicket, goDaddyApiCredentials, type GoDaddyApiDependencies } from "./api";
import { GODADDY_PROVIDER as PROVIDER } from "./definition";
import { fetchPortalCaseStatus } from "./portal";
import { type AnswerFetch } from "../../../http/fetch";

/**
 * What GoDaddy's states mean for the report. The API's `closeReason`
 * `actioned` and the portal's `Closed` ("reviewed and resolved. Appropriate
 * action has been taken") are acknowledgements; anything else is no decision
 * yet or an undocumented reason that a person reads.
 */
export const GODADDY_REVIEW_VERDICTS: Readonly<Record<string, AbuseMailClassification>> = {
	actioned: "acknowledged",
	closed: "acknowledged",
};

/**
 * The case's state by its id. Our own reference (a portal filing whose case
 * id arrives only by mail) names nothing to look up yet. A ticket the Abuse
 * API knows is read there; otherwise (no key, or a ticket the portal filed)
 * through the public case lookup.
 */
export async function fetchGoDaddyCorrespondence(
	context: { confirmationId: string; signal?: AbortSignal },
	dependencies: GoDaddyApiDependencies & { portalFetch?: AnswerFetch } = {},
): Promise<ProviderCorrespondence> {
	const caseId = context.confirmationId;
	if (isReportReference(caseId) || !new RegExp(`^${PROVIDER.portal.casePattern}$`).test(caseId)) return { messages: [] };
	const signal = context.signal ?? dependencies.signal;
	const credentials = goDaddyApiCredentials(dependencies.environment);
	const ticket = credentials ? await fetchGoDaddyTicket(credentials, caseId, { ...dependencies, ...(signal ? { signal } : {}) }) : undefined;
	if (ticket) {
		const state = ticket.closed ? (ticket.closeReason ?? "closed").toLowerCase() : "open";
		return { messages: [], status: { state, ...(ticket.closed ? { detail: ticket.closeReason ? `GoDaddy closed the ticket: ${ticket.closeReason}` : "GoDaddy closed the ticket." } : {}) }, final: ticket.closed };
	}
	const status = await fetchPortalCaseStatus(caseId, { ...(dependencies.portalFetch ? { fetch: dependencies.portalFetch } : {}), ...(signal ? { signal } : {}) });
	return status ? { messages: [], status: { state: status.state }, final: status.final } : { messages: [] };
}
