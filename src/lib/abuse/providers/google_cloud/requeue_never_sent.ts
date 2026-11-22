import { AbuseRepository } from "../../repository";
import { GOOGLE_CLOUD_PROVIDER } from "./definition";

/**
 * Puppeteer's connect to the leased Fabric browser failed (2026-11-20/22). It
 * asks for the browser's contexts before any page exists, and the provider
 * opened its browser first, so a run that failed with exactly this sent nothing.
 */
export const GOOGLE_CLOUD_BROWSER_NEVER_STARTED = "Protocol error (Target.getBrowserContexts): Target closed";

/**
 * One-off: return the Google Cloud routes whose browser never started, which
 * the old provider recorded as "maybe filed" because it opened the browser
 * after its marker, to the queue. Any other unresolved route stays as it is.
 */
export function requeueGoogleCloudRunsWhoseBrowserNeverStarted(): Promise<bigint[]> {
	return AbuseRepository.requeueNeverSentProviderRuns({
		providerRegistryKey: GOOGLE_CLOUD_PROVIDER.key,
		neverSentFailure: GOOGLE_CLOUD_BROWSER_NEVER_STARTED,
		reason: "browser connect failed before the form was opened; nothing was sent",
	});
}
