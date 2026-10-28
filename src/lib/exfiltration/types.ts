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
