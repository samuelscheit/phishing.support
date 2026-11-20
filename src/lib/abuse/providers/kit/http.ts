import { ProviderSubmissionRejectedError } from "../submission_contracts";

/** The provider named a bad request: nothing was filed. `detail` is a snippet of its answer. */
const refused = (provider: string, status: number, detail: string) => new ProviderSubmissionRejectedError(`${provider} refused the report (HTTP ${status}): ${detail}`);

/** An answer that leaves it open whether the provider kept the report. `where` names the URL when it matters. */
const answeredWith = (provider: string, status: number, detail: string, where = "") => new Error(`${provider} answered the report with HTTP ${status}${where}: ${detail}`);

/** Settle a non-2xx answer: a listed status is a refusal (nothing filed), anything else is ambiguous. */
export function failUnlessFiled(provider: string, answer: { status: number; ok: boolean }, detail: string, refusedStatuses: readonly number[]): void {
	if (refusedStatuses.includes(answer.status)) throw refused(provider, answer.status, detail);
	if (!answer.ok) throw answeredWith(provider, answer.status, detail);
}
