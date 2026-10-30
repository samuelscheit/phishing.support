/** Map a bounded number of independent operations without building an unbounded promise fan-out. */
export async function mapConcurrent<T, R>(
	values: readonly T[],
	concurrency: number,
	operation: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
	const result = new Array<R>(values.length);
	let next = 0;
	const worker = async () => {
		while (next < values.length) {
			const index = next++;
			result[index] = await operation(values[index]!, index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, worker));
	return result;
}
