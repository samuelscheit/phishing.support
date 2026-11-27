/** `error` and every `Error` in its `cause` chain, outermost first; a cyclic chain ends at its first repeat. */
export function errorChain(error: unknown): Error[] {
	const chain: Error[] = [];
	for (let current = error; current instanceof Error && !chain.includes(current); current = current.cause) chain.push(current);
	return chain;
}
