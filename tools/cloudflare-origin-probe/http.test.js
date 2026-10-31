import { describe, expect, test } from "bun:test";
import { splitHttpResponse } from "./http.js";

describe("raw HTTP response parsing", () => {
	test("extracts a fixed-length response", () => {
		const parsed = splitHttpResponse(Buffer.from("HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: 17\r\n\r\nerror code: 1034\n"));
		expect(parsed.status).toBe(403);
		expect(parsed.headers["content-type"]).toBe("text/plain");
		expect(parsed.body.toString()).toBe("error code: 1034\n");
	});

	test("decodes chunk extensions and joins chunks before matching evidence", () => {
		const parsed = splitHttpResponse(
			Buffer.from("HTTP/1.1 403 Forbidden\r\nTransfer-Encoding: chunked\r\n\r\n5;foo=bar\r\nEdge \r\nD\r\nIP Restricted\r\n0\r\nTrailer: ignored\r\n\r\n"),
		);
		expect(parsed.body.toString()).toBe("Edge IP Restricted");
	});

	test("preserves a body when no HTTP header boundary exists", () => {
		const parsed = splitHttpResponse(Buffer.from("raw bytes"));
		expect(parsed.status).toBeNull();
		expect(parsed.body.toString()).toBe("raw bytes");
	});
});
