import { describe, expect, test } from "bun:test";

import { GET } from "@/app/api/submissions/[id]/route";
import { SubmissionsEntity } from "@/lib/db/entities/submissions";
import { useTemporaryDatabase } from "@/lib/db/test_helpers";
import { publicReporterHeaders } from "@/lib/http/reporter_headers";

useTemporaryDatabase();

const IP = "203.0.113.9";
const IPV6 = "2001:db8::7";

async function getDetail(id: string) {
	const response = await GET(new Request(`http://localhost/api/submissions/${id}`), { params: Promise.resolve({ id }) });
	return { status: response.status, text: await response.text() };
}

describe("public submission detail", () => {
	test("never contains the reporter's IP, in the field or in any forwarded header", async () => {
		await SubmissionsEntity.create({ id: 1n, kind: "website", data: { kind: "website", website: { url: "https://kit.example.com" } }, dedupeKey: "d-1", status: "reported", source: "test" });
		await SubmissionsEntity.update(1n, {
			reporterIp: IP,
			reporterCountry: "DE",
			reporterHeaders: {
				"cf-connecting-ip": IP,
				"x-forwarded-for": `${IP}, 10.0.0.1`,
				"x-real-ip": IP,
				forwarded: `for="[${IPV6}]:443"`,
				"true-client-ip": IP,
				cookie: "session=secret",
				"User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
				"sec-ch-ua-model": "\"Pixel 8\"",
			},
		});

		const { status, text } = await getDetail("1");
		expect(status).toBe(200);
		expect(text).not.toContain(IP);
		expect(text).not.toContain(IPV6);
		expect(text).not.toContain("session=secret");
		const body = JSON.parse(text);
		expect("reporterIp" in body).toBe(false);
		expect(body.reporterCountry).toBe("DE");
		expect(body.reporterHeaders).toEqual({
			"user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
			"sec-ch-ua-model": "\"Pixel 8\"",
		});
	});

	test("a case without reporter metadata has no headers and no IP", async () => {
		await SubmissionsEntity.create({ id: 2n, kind: "website", data: { kind: "website", website: { url: "https://kit2.example.com" } }, dedupeKey: "d-2", status: "reported", source: "test" });
		const body = JSON.parse((await getDetail("2")).text);
		expect("reporterIp" in body).toBe(false);
		expect(body.reporterHeaders).toBeNull();
	});

	test("an unknown or malformed id is 404", async () => {
		expect((await getDetail("999")).status).toBe(404);
		expect((await getDetail("not-a-number")).status).toBe(404);
	});
});

describe("publicReporterHeaders", () => {
	test("keeps only device headers from every persisted shape", () => {
		expect(publicReporterHeaders({ "x-forwarded-for": IP })).toBeNull();
		expect(publicReporterHeaders(null)).toBeNull();
		expect(publicReporterHeaders([["X-User-Agent", "UA"], ["X-Real-IP", IP]])).toEqual({ "x-user-agent": "UA" });
		expect(publicReporterHeaders(JSON.stringify({ "user-agent": "UA", "cf-connecting-ip": IP }))).toEqual({ "user-agent": "UA" });
		expect(publicReporterHeaders({ "user-agent": "   " })).toBeNull();
	});
});
