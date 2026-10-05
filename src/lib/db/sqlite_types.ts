import { customType } from "drizzle-orm/sqlite-core";

/**
 * The application enables Bun SQLite's `safeIntegers` mode so database IDs
 * never lose precision. Bun consequently returns every SQLite INTEGER as a
 * bigint, including bounded counters and byte sizes. Keep identifiers exact,
 * but decode ordinary bounded values at the schema boundary so callers never
 * accidentally combine a bigint with a number.
 */
export const sqliteBigint = customType<{ data: bigint; driverData: bigint }>({
	dataType: () => "INTEGER",
	fromDriver: (value) => BigInt(value),
	// Drizzle's Bun SQLite adapter accepts a string representation for values
	// outside JavaScript's safe number range.
	// @ts-expect-error drizzle's custom-type driver declaration is narrower than SQLite.
	toDriver: (value) => value.toString(),
});

export const sqliteInteger = customType<{ data: number; driverData: bigint }>({
	dataType: () => "INTEGER",
	fromDriver: (value) => {
		const number = Number(value);
		if (!Number.isSafeInteger(number)) {
			throw new RangeError("SQLite integer exceeds JavaScript's safe numeric range.");
		}
		return number;
	},
	toDriver: (value) => {
		if (!Number.isSafeInteger(value)) {
			throw new RangeError("Expected a safe integer for SQLite storage.");
		}
		return BigInt(value);
	},
});

export const sqliteTimestamp = customType<{ data: Date; driverData: bigint }>({
	dataType: () => "INTEGER",
	fromDriver: (value) => new Date(Number(value)),
	toDriver: (value) => BigInt(value.getTime()),
});
