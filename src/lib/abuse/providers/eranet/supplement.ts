import type { DecisionAnswer } from "../submission_contracts";
import { ProviderSubmissionRejectedError } from "../submission_contracts";
import { ERANET_PROVIDER } from "./definition";
import { errorOf, openEranetBrowserSession, uploadAndRequestCode, type EranetDependencies } from "./submission";

/** The upload type of the supplement form's screenshots (its "check-progress" page, 2026-11-16). */
const SUPPLEMENT_UPLOAD_TYPE = "ownershipProof";
/** The supplement form takes at most 12 images. */
const MAX_SUPPLEMENT_SCREENSHOTS = 12;

/**
 * Answer a complaint Eranet set to "supplement required" through its
 * "Supplementary Materials Required" form: the answer's text, its screenshots
 * (the form requires at least one), and a freshly mailed code, then the one
 * `Supplement` request that files it. Eranet asked for this on binanceusa.org
 * and keychainagent.pro: "Based on the materials you have provided, we are
 * unable to determine whether the website has committed any violations."
 */
export async function submitEranetSupplement(
	answer: DecisionAnswer,
	markSending: () => Promise<void>,
	dependencies: Pick<EranetDependencies, "openSession" | "readCode" | "now"> = {},
): Promise<void> {
	const screenshots = answer.attachments
		.filter((file) => (ERANET_PROVIDER.evidence.acceptedMimeTypes as readonly string[]).includes(file.mimeType) && file.content.byteLength <= ERANET_PROVIDER.evidence.maximumBytes)
		.slice(0, MAX_SUPPLEMENT_SCREENSHOTS);
	if (!screenshots.length) throw new Error("Eranet's supplement form requires a screenshot, and the answer has none.");
	const session = await (dependencies.openSession ?? openEranetBrowserSession)();
	try {
		const { screenshots: files, code } = await uploadAndRequestCode(session, SUPPLEMENT_UPLOAD_TYPE, screenshots, answer.signal, dependencies);
		await markSending();
		const filed = await session.call("Supplement", { json: { OrderNo: answer.confirmationId, Email: ERANET_PROVIDER.reporter.email, Code: code, Contents: answer.body, Files: files.join(",") } });
		// Eranet names every refusal; a named error filed nothing.
		if (errorOf(filed)) throw new ProviderSubmissionRejectedError(`Eranet refused the supplement: ${errorOf(filed)}`);
	} finally {
		await session.close();
	}
}
