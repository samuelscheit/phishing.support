/**
 * For tests that run the captcha probe in this process against a scripted
 * document: the page globals it needs beyond `document`. Call `sync` before
 * each look with the solver's current attributes; a change since the last
 * look is reported as the solver's write, as a real MutationObserver would.
 */
export function captchaGlobals() {
	const observers: Array<(records: unknown[]) => void> = [];
	let seen: string | undefined;
	return {
		window: { addEventListener: () => undefined } as Record<string, unknown>,
		MutationObserver: class {
			constructor(callback: (records: unknown[]) => void) { observers.push(callback); }
			observe() { return undefined; }
		},
		sync(attributes: object) {
			const now = JSON.stringify(attributes);
			if (seen !== undefined && now !== seen) for (const observer of observers) observer([{}]);
			seen = now;
		},
	};
}
