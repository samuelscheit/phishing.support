import { openBrowserForm } from "./browser_form";
import type { ProviderSubmissionPreflight } from "../submission_contracts";

/** The default way a form provider opens its page: a real Chrome on the form with the challenge passed. */
export function formOpener(definition: { displayName: string }, operation: string, page: { url: string; formSelector: string }) {
	return (signal: AbortSignal | undefined) => openBrowserForm({
		provider: definition.displayName,
		operation,
		url: page.url,
		formSelector: page.formSelector,
		...(signal ? { signal } : {}),
	});
}

/**
 * Open a session, let `prepare` use it before the marker and hand its result
 * to the executor with a disposer. A failure closes the session first: nothing
 * was filed, so every failure here is a safe retry.
 */
export async function withPreflight<S extends { close(): Promise<void> }, State>(
	open: () => Promise<S>,
	prepare: (session: S) => Promise<State>,
): Promise<ProviderSubmissionPreflight> {
	const session = await open();
	try {
		return { state: await prepare(session), dispose: () => session.close() };
	} catch (error) {
		await session.close();
		throw error;
	}
}

/** The state the preflight left for the irreversible request, or the provider's "requires its prepared …" error. */
export function preparedState<State>(preflight: ProviderSubmissionPreflight, isComplete: (state: State) => boolean, message: string): State {
	const state = preflight.state as State | undefined;
	if (!state || !isComplete(state)) throw new Error(message);
	return state;
}
