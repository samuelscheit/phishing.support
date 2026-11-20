import { defineProvider } from "../kit/provider";
import { DISCORD_WEBHOOK_PROVIDER } from "./definition";
import { prepareDiscordWebhookDeletion, submitDiscordWebhookDeletion } from "./submission";

/** Supplemental route that deletes a confirmed phishing kit's Discord webhook with the token the kit carries. */
export const discordWebhookProvider = defineProvider({
	definition: DISCORD_WEBHOOK_PROVIDER,
	prepare: prepareDiscordWebhookDeletion,
	preview: () => "The phishing kit's Discord webhook is deleted through Discord's API with the token the kit itself carries, so it can no longer post what visitors type.",
	submit: (context) => submitDiscordWebhookDeletion(context),
});
