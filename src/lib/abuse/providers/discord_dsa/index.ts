import type { ProviderSubmissionProvider } from "../submission_contracts";
import { DISCORD_DSA_PROVIDER } from "./definition";
import { prepareDiscordDsaExternalSubmission, prepareDiscordDsaSubmission, submitDiscordDsaSubmission } from "./submission";

/** Supplemental route that files a DSA notice about the server of a phishing kit's Discord webhook. */
export const discordDsaProvider: ProviderSubmissionProvider = {
	definition: DISCORD_DSA_PROVIDER,
	prepareSubmission: (context) => prepareDiscordDsaSubmission(context),
	buildReportPreview: () => "A Digital Services Act notice is filed through discord.com/report about the server the phishing kit's webhook posts to, verified by a key Discord mails to the service mailbox.",
	prepareExternalSubmission: (context) => prepareDiscordDsaExternalSubmission(context),
	submit: () => Promise.reject(new Error("Discord DSA submission needs its prepared form.")),
	submitPrepared: submitDiscordDsaSubmission,
};
