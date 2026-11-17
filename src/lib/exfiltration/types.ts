export type ExfiltrationCanaries = {
	marker: string;
	email: string;
	password: string;
	phone: string;
	cardNumber: string;
	oneTimeCode: string;
};

export type CapturedNetworkRequest = {
	timestamp: string;
	url: string;
	method: string;
	resourceType?: string;
	postData?: string;
	webSocketPayload?: string;
	/** The page or frame the request was sent from. */
	documentUrl?: string;
	/** The headers that show how the data was sent: content type, origin, referrer. */
	requestHeaders?: Record<string, string>;
	/** The server's answer, when one arrived while the visit was recorded. */
	/** The server's answer. No address: the browser reaches sites through an egress proxy, so the peer it sees is the proxy. */
	response?: { status: number; statusText?: string; receivedAt: string; mimeType?: string };
};

export type ExfiltrationBackend = {
	kind: "telegram_bot" | "discord_webhook" | "domain";
	key: string;
	endpointUrl: string;
	hostname: string;
	method: string;
	matchedCanaries: Array<keyof ExfiltrationCanaries>;
	request: CapturedNetworkRequest;
	telegram?: { token: string; botId?: string; username?: string; chatId?: string };
	discord?: { webhookId: string; token: string; guildId?: string; channelId?: string; name?: string };
};
