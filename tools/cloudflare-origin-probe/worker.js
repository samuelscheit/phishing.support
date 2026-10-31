import { connect } from "cloudflare:sockets";
import { isAuthorized, parseTunnelTarget, TUNNEL_PORT } from "./core.js";

function json(status, body) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"cache-control": "no-store",
			"content-type": "application/json; charset=utf-8",
		},
	});
}

function closeWebSocket(webSocket, code, reason) {
	try {
		webSocket.close(code, reason);
	} catch {
		// The peer may already have closed the tunnel.
	}
}

function relayWebSocketToSocket(webSocket, socket) {
	let writer;
	let writes = Promise.resolve();

	const writerReady = socket.opened.then(() => {
		writer = socket.writable.getWriter();
		return writer;
	});

	webSocket.addEventListener("message", ({ data }) => {
		if (typeof data === "string") {
			closeWebSocket(webSocket, 1003, "binary frames required");
			void socket.close();
			return;
		}
		writes = writes
			.then(async () => {
				const openWriter = await writerReady;
				const bytes = data instanceof ArrayBuffer
					? new Uint8Array(data)
					: ArrayBuffer.isView(data)
						? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
						: new Uint8Array(await data.arrayBuffer());
				await openWriter.write(bytes);
			})
			.catch(() => {
				closeWebSocket(webSocket, 1011, "upstream write failed");
				void socket.close();
			});
	});

	webSocket.addEventListener("close", () => {
		void writer?.close().catch(() => undefined);
		void socket.close();
	});

	webSocket.addEventListener("error", () => {
		void socket.close();
	});
}

async function relaySocketToWebSocket(socket, webSocket) {
	try {
		await socket.opened;
		await socket.readable.pipeTo(
			new WritableStream({
				write(chunk) {
					webSocket.send(chunk);
				},
			}),
		);
		closeWebSocket(webSocket, 1000, "upstream closed");
	} catch {
		closeWebSocket(webSocket, 1011, "upstream connection failed");
	} finally {
		void socket.close();
	}
}

function openTunnel(target, context) {
	const pair = new WebSocketPair();
	const client = pair[0];
	const server = pair[1];
	server.accept();

	// TLS is intentionally not terminated here. The local probe sends its
	// ClientHello through this byte tunnel, preserving the exact SNI value.
	const socket = connect(target, { secureTransport: "off", allowHalfOpen: false });
	relayWebSocketToSocket(server, socket);
	context.waitUntil(relaySocketToWebSocket(socket, server));

	return new Response(null, { status: 101, webSocket: client });
}

export default {
	async fetch(request, env, context) {
		const url = new URL(request.url);
		if (url.pathname === "/" || url.pathname === "/health") {
			return json(200, { ok: true, service: "cloudflare-origin-probe", transport: "tcp", port: TUNNEL_PORT });
		}

		if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			return json(426, { error: "WebSocket upgrade required" });
		}
		if (!isAuthorized(request, env)) return json(401, { error: "authentication required" });

		try {
			return openTunnel(parseTunnelTarget(url.pathname), context);
		} catch (error) {
			return json(400, { error: error instanceof Error ? error.message : "invalid target" });
		}
	},
};
