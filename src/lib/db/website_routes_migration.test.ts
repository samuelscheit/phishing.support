import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { applyMigration, databaseBefore } from "./migration_test_helpers";

const MIGRATION = "0030_website_routes";

/**
 * Migration 0030 moves a website case's single chain into the first of its
 * routes. The rows are written as raw JSON text, so the test also sees what
 * the migration does to number literals and key order, which a parsed object
 * would hide.
 */
function databaseWith(rows: Array<{ id: number; kind?: string; data: string }>): Database {
	const database = databaseBefore(MIGRATION);
	const insert = database.query("INSERT INTO submissions (id, kind, data, dedupe_key, status) VALUES (?, ?, ?, ?, 'reported')");
	for (const row of rows) insert.run(row.id, row.kind ?? "website", row.data, `dedupe-${row.id}`);
	return database;
}

const readData = (database: Database, id: number) => (database.query("SELECT data FROM submissions WHERE id = ?").get(id) as { data: string }).data;
const allData = (database: Database) => database.query("SELECT id, data FROM submissions ORDER BY id").all();

// Website fields outside the chain, in the order a case wrote them; the migration must leave them as they are.
const whois = '{"registrar":"Example Registrar","createdAt":"2025-01-02T03:04:05.000Z","ageDays":12}';
const investigation = '{"steps":[{"kind":"visit","at":1795000000000}],"notes":null}';
const hops =
	'[{"index":0,"url":"https://bit.ly/x","hostname":"bit.ly","status":301,"redirectTo":"https://kit.example/","contentCaptured":false,"timingMs":12.50},' +
	'{"index":1,"url":"https://kit.example/","hostname":"kit.example","status":200,"contentCaptured":true,"artifactId":9007199254740993,"title":null}]';
const siteAssessments = '[{"hostname":"bit.ly","verdict":"benign","confidence":0.1},{"hostname":"kit.example","verdict":"phishing","confidence":1e-7}]';
const funnel = '{"trackerHost":"bit.ly","offer":{"name":"Prize","payout":null},"steps":[1,2.0]}';
const visit = '{"actions":[{"type":"fill","field":"email","value":"synthetic@example.com"}],"submittedTo":null,"durationMs":1500}';

test("0030 moves a full chain into the first route, keeping every value and the case's other fields", () => {
	const data = `{"kind":"website","website":{"url":"https://bit.ly/x","whois":${whois},"navigationHops":${hops},"analyzedHopIndex":0,"siteAssessments":${siteAssessments},"archiveUrl":"https://archive.example/abc","funnel":${funnel},"visit":${visit},"investigation":${investigation}},"reporter":"me"}`;
	const database = databaseWith([{ id: 1, data }]);
	applyMigration(database, MIGRATION);
	const migrated = readData(database, 1);

	// The route's members in the type's order, nested nulls inside the funnel, visit and hops kept.
	expect(migrated).toBe(
		`{"kind":"website","website":{"url":"https://bit.ly/x","whois":${whois},"archiveUrl":"https://archive.example/abc","investigation":${investigation},` +
			`"routes":[{"hops":${hops},"analyzedHopIndex":0,"siteAssessments":${siteAssessments},"funnel":${funnel},"visit":${visit}}]},"reporter":"me"}`,
	);
	// Number literals are copied as written, beyond what a double holds.
	expect(migrated).toContain('"artifactId":9007199254740993');
	expect(migrated).toContain('"timingMs":12.50');
	expect(migrated).toContain('"confidence":1e-7');
	expect(migrated).toContain('"steps":[1,2.0]');
	expect(JSON.parse(migrated).website.routes[0].analyzedHopIndex).toBe(0);
});

test("0030 makes a route of a chain alone, holding no members the case did not have", () => {
	const database = databaseWith([
		{ id: 1, data: `{"kind":"website","website":{"url":"https://kit.example/","navigationHops":${hops}}}` },
		// Members stored as null are no members: the route's fields are optional, not nullable.
		{ id: 2, data: `{"kind":"website","website":{"url":"https://kit.example/","navigationHops":[],"analyzedHopIndex":null,"funnel":null,"visit":{"actions":[]}}}` },
	]);
	applyMigration(database, MIGRATION);

	expect(readData(database, 1)).toBe(`{"kind":"website","website":{"url":"https://kit.example/","routes":[{"hops":${hops}}]}}`);
	expect(readData(database, 2)).toBe('{"kind":"website","website":{"url":"https://kit.example/","routes":[{"hops":[],"visit":{"actions":[]}}]}}');
});

test("0030 drops the chain's keys of a case without a chain, giving it no route", () => {
	const database = databaseWith([
		{ id: 1, data: `{"kind":"website","website":{"url":"https://a.example/","siteAssessments":${siteAssessments},"archiveUrl":"https://archive.example/a"}}` },
		// A chain that is no array is no chain either.
		{ id: 2, data: '{"kind":"website","website":{"url":"https://b.example/","navigationHops":{"0":"x"},"analyzedHopIndex":3,"funnel":{},"visit":{}}}' },
	]);
	applyMigration(database, MIGRATION);

	expect(readData(database, 1)).toBe('{"kind":"website","website":{"url":"https://a.example/","archiveUrl":"https://archive.example/a"}}');
	expect(readData(database, 2)).toBe('{"kind":"website","website":{"url":"https://b.example/"}}');
});

test("0030 leaves rows it cannot or need not convert exactly as they are", () => {
	const untouched = [
		// Unreadable data: one such row must not fail the migration either.
		{ id: 1, data: '{"kind":"website","website":{"navigationHops":[' },
		// An email case, even one holding website-like keys.
		{ id: 2, kind: "email", data: `{"kind":"email","website":{"navigationHops":${hops},"analyzedHopIndex":1}}` },
		// A case the new code wrote, even with a leftover old key.
		{ id: 3, data: `{"kind":"website","website":{"url":"https://kit.example/","routes":[{"hops":${hops},"analyzedHopIndex":1}],"analyzedRoute":0,"navigationHops":[]}}` },
		// A case with nothing to move, and ones whose website part is no object.
		{ id: 4, data: '{"kind":"website","website":{"url":"https://plain.example/","archiveUrl":"https://archive.example/p"}}' },
		{ id: 5, data: '{"kind":"website","website":"https://string.example/"}' },
		{ id: 6, data: '{"kind":"website"}' },
		{ id: 7, data: "[1,2,3]" },
	];
	const database = databaseWith(untouched);
	applyMigration(database, MIGRATION);

	for (const row of untouched) expect(readData(database, row.id)).toBe(row.data);
});

test("0030 run a second time changes nothing more", () => {
	const database = databaseWith([
		{ id: 1, data: `{"kind":"website","website":{"url":"https://bit.ly/x","navigationHops":${hops},"analyzedHopIndex":1,"siteAssessments":${siteAssessments},"funnel":${funnel},"visit":${visit}}}` },
		{ id: 2, data: `{"kind":"website","website":{"url":"https://a.example/","siteAssessments":${siteAssessments}}}` },
		{ id: 3, data: `{"kind":"website","website":{"url":"https://kit.example/","navigationHops":${hops}}}` },
		{ id: 4, data: "not json" },
	]);
	applyMigration(database, MIGRATION);
	const once = allData(database);
	expect(JSON.parse(readData(database, 1)).website.routes).toHaveLength(1);

	applyMigration(database, MIGRATION);
	expect(allData(database)).toEqual(once);
});
