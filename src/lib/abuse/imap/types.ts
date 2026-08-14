type EnvelopeAddress = { address?: string | null };

export type FetchedAbuseMail = {
	uid: number;
	source?: Buffer | Uint8Array | string;
	flags?: ReadonlySet<string> | { has(flag: string): boolean } | readonly string[];
	envelope?: {
		to?: EnvelopeAddress[];
		cc?: EnvelopeAddress[];
		bcc?: EnvelopeAddress[];
		messageId?: string;
	};
	internalDate?: Date | string;
};

export type AbuseImapConfig = {
	host: string;
	port: number;
	secure: boolean;
	user: string;
	pass: string;
	mailbox: string;
	processSeen: boolean;
};

export type AbuseMailIngestResult =
	| { disposition: "terminal"; route: "reply" | "ignored"; reason: string; messageId?: bigint }
	| { disposition: "retry"; reason: string };
