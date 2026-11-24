import { describe, expect, test } from "bun:test";

import { buildVisitEvidence, type VisitEvidenceFacts } from "./visit";
import { sha256Hex } from "../util/hash";

const values = { marker: "ps-7f3a", email: "ps-7f3a@mail.example", password: "Pw-7f3a-x", phone: "+15550107", cardNumber: "4111111111111111", oneTimeCode: "730215" };

const facts: VisitEvidenceFacts = {
	caseId: "380153057440174080",
	route: 0,
	submittedUrl: "https://policy-trust-assurance.onrender.com/help",
	startedAt: new Date("2026-11-15T00:32:40.000Z"),
	endedAt: new Date("2026-11-15T00:34:10.000Z"),
	environment: { device: "Google Chrome on Windows", egress: "Browser Fabric egress policy egress_tor@1", agent: "Browser Fabric task agent", agentOutcome: "completed" },
	syntheticValues: values,
	actions: [
		{ id: "2.1", kind: "type", text: `typed into e3 its value is now ${JSON.stringify(values.email)}`, selector: "e3", value: values.email, at: "2026-11-15T00:32:51.100Z" },
		// A secret as the visit keeps it: the value the browser typed, with the placeholder the agent typed it as.
		{ id: "2.2", kind: "type", text: `typed into e4 its value is now ${JSON.stringify(values.password)}`, selector: "e4", value: values.password, typedAs: "{{secret:password}}", at: "2026-11-15T00:32:53.400Z" },
		{ id: "3.1", kind: "click", text: 'clicked e5 "Weitermachen"', selector: "e5", at: "2026-11-15T00:32:54.000Z" },
	],
	pages: [{ url: "https://policy-trust-assurance.onrender.com/help", shownFrom: new Date("2026-11-15T00:32:40.000Z") }],
	requests: [
		{ timestamp: "2026-11-15T00:32:41.000Z", url: "https://policy-trust-assurance.onrender.com/_next/static/chunks/a.js", method: "GET", resourceType: "Script" },
		{
			timestamp: "2026-11-15T00:32:54.200Z",
			url: "https://policy-trust-assurance.onrender.com/api/send",
			method: "POST",
			postData: JSON.stringify({ email: values.email, password: values.password }),
			documentUrl: "https://policy-trust-assurance.onrender.com/help",
			requestHeaders: { "content-type": "application/json" },
			response: { status: 200, receivedAt: "2026-11-15T00:32:54.480Z" },
		},
	],
	backends: [],
};

describe("the visit as evidence", () => {
	test("keeps every request with what it carried, the values and the actions, and names the files by hash in a timestamped manifest", async () => {
		const stamped: Buffer[] = [];
		const evidence = await buildVisitEvidence(facts, {
			timestamp: async (content) => {
				stamped.push(content);
				return { authority: "Test TSA", authorityUrl: "http://tsa.test", time: "2026-11-15T00:34:11Z", serialNumber: "7", token: Buffer.from("token") };
			},
		});
		expect(evidence.files.map((file) => file.name)).toEqual(["visit-record.json", "visit-protocol.txt", "visit-manifest.json", "visit-manifest.tsr"]);
		const [record, protocol, manifest, token] = evidence.files;
		// The token covers exactly the manifest, and the manifest exactly the two files.
		expect(stamped).toEqual([manifest!.bytes]);
		expect(token!.bytes.toString()).toBe("token");
		expect(JSON.parse(manifest!.bytes.toString())).toMatchObject({
			caseId: facts.caseId,
			files: [
				{ name: "visit-record.json", sha256: sha256Hex(record!.bytes), size: record!.bytes.byteLength },
				{ name: "visit-protocol.txt", sha256: sha256Hex(protocol!.bytes), size: protocol!.bytes.byteLength },
			],
		});

		const parsed = JSON.parse(record!.bytes.toString());
		expect(parsed.syntheticValues).toEqual(values);
		expect(parsed.actions[0]).toEqual(facts.actions[0]);
		expect(parsed.actions[1]).toMatchObject({ value: values.password, typedAs: "{{secret:password}}" });
		expect(parsed.requests.map((request: { method: string; carries: string[] }) => [request.method, request.carries])).toEqual([["GET", []], ["POST", ["email", "password"]]]);
		expect(parsed.requests[1]).toMatchObject({ postData: facts.requests[1]!.postData, response: { status: 200 } });

		const text = protocol!.bytes.toString();
		expect(text).toContain("They were generated for this visit only and belong to no person");
		expect(text).toContain(`  email address: ${values.email}`);
		// The chronology reads in time order: typing, clicking, then the request that carried both values.
		expect(text).toContain("Visiting agent: Browser Fabric task agent, outcome completed");
		const typedEmail = text.indexOf(`value ${JSON.stringify(values.email)} [element e3]`);
		expect(text).toContain(`Agent type: typed into e4 its value is now ${JSON.stringify(values.password)} value ${JSON.stringify(values.password)} (typed as {{secret:password}}) [element e4]`);
		const clicked = text.indexOf('Agent click: clicked e5 "Weitermachen"');
		const sent = text.indexOf("Request POST https://policy-trust-assurance.onrender.com/api/send carried the synthetic email address, password, sent from https://policy-trust-assurance.onrender.com/help. Answer: HTTP 200 at 2026-11-15 00:32:54.480 UTC.");
		expect(typedEmail).toBeGreaterThan(0);
		expect(clicked).toBeGreaterThan(typedEmail);
		expect(sent).toBeGreaterThan(clicked);
		expect(text).toContain("Requests that carried a synthetic value: 1. Every other request the browser sent during the visit (1)");
		expect(text).toContain(`SHA-256 of visit-record.json: ${sha256Hex(record!.bytes)}`);
	});

	test("without a reachable timestamp authority the record is still kept, without a token", async () => {
		const evidence = await buildVisitEvidence({ ...facts, requests: [], actions: [] }, { timestamp: async () => undefined });
		expect(evidence.files.map((file) => file.name)).toEqual(["visit-record.json", "visit-protocol.txt", "visit-manifest.json"]);
		expect(evidence.timestamp).toBeUndefined();
		expect(evidence.files[1]!.bytes.toString()).toContain("Requests that carried a synthetic value: 0.");
	});

	test("the same visit gives the same record bytes, so its hash can be reproduced", async () => {
		const none = { timestamp: async () => undefined };
		const [first, second] = await Promise.all([buildVisitEvidence(facts, none), buildVisitEvidence(facts, none)]);
		expect(sha256Hex(first.files[0]!.bytes)).toBe(sha256Hex(second.files[0]!.bytes));
	});
});
