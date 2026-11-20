import { defineProvider } from "../kit/provider";
import { DISCORD_DSA_PROVIDER } from "./definition";
import { prepareDiscordDsaExternalSubmission, discordDsaDraft, submitDiscordDsaSubmission } from "./submission";

/** Supplemental route that files a DSA notice about the server of a phishing kit's Discord webhook. */
export const discordDsaProvider = defineProvider({
	definition: DISCORD_DSA_PROVIDER,
	draft: discordDsaDraft,
	preview: () => "A Digital Services Act notice is filed through discord.com/report about the server the phishing kit's webhook posts to, verified by a key Discord mails to the service mailbox.",
	external: {
		prepare: (context) => prepareDiscordDsaExternalSubmission(context),
		submit: submitDiscordDsaSubmission,
	},
});
