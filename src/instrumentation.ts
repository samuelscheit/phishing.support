/**
 * Before the first request: the WebSocket server next-ws upgrades into
 * (`UPGRADE` of a route), with a cap on what a client may send at once. The
 * same in `next dev` and the custom server.
 */
export async function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;
	const [{ setWebSocketServer }, { WebSocketServer }, { MAX_CLIENT_MESSAGE }] = await Promise.all([import("next-ws/server"), import("ws"), import("./lib/site_visit/live_protocol")]);
	setWebSocketServer(new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE }));
}
