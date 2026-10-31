function decodeChunkedBody(buffer) {
	const chunks = [];
	let offset = 0;
	while (offset < buffer.length) {
		const lineEnd = buffer.indexOf("\r\n", offset);
		if (lineEnd === -1) throw new Error("invalid chunked response: missing size delimiter");
		const sizeText = buffer.subarray(offset, lineEnd).toString("ascii").split(";", 1)[0];
		const size = Number.parseInt(sizeText, 16);
		if (!Number.isFinite(size)) throw new Error("invalid chunked response: invalid size");
		offset = lineEnd + 2;
		if (size === 0) return Buffer.concat(chunks);
		const chunkEnd = offset + size;
		if (chunkEnd + 2 > buffer.length || buffer.subarray(chunkEnd, chunkEnd + 2).toString("ascii") !== "\r\n") {
			throw new Error("invalid chunked response: incomplete chunk");
		}
		chunks.push(buffer.subarray(offset, chunkEnd));
		offset = chunkEnd + 2;
	}
	throw new Error("invalid chunked response: missing terminator");
}

export function splitHttpResponse(buffer) {
	const boundary = buffer.indexOf("\r\n\r\n");
	if (boundary === -1) return { status: null, headers: {}, body: buffer };
	const headerText = buffer.subarray(0, boundary).toString("latin1");
	const lines = headerText.split("\r\n");
	const status = Number(lines.shift()?.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/)?.[1] ?? 0) || null;
	const headers = Object.fromEntries(
		lines.map((line) => {
			const separator = line.indexOf(":");
			return separator === -1 ? [line.toLowerCase(), ""] : [line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim()];
		}),
	);
	const encodedBody = buffer.subarray(boundary + 4);
	const body = headers["transfer-encoding"]?.toLowerCase().includes("chunked") ? decodeChunkedBody(encodedBody) : encodedBody;
	return { status, headers, body };
}
