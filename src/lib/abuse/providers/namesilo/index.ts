import { defineProvider } from "../kit/provider";
import { NAMESILO_PROVIDER } from "./definition";
import { makeNameSiloExplanation } from "./payload";
import { prepareNameSiloExternalSubmission, nameSiloDraft, submitNameSiloSubmission } from "./submission";

/** NameSilo owns its exact mailboxes, form contract, CSRF state, and upload. */
export const nameSiloProvider = defineProvider({
	definition: NAMESILO_PROVIDER,
	draft: nameSiloDraft,
	preview: (context) => makeNameSiloExplanation({
		target: context.target,
		observedUrl: context.observedUrls[0],
		description: context.description,
		...(context.allegationCategory ? { allegationCategory: context.allegationCategory } : {}),
		...(context.legalBrandUrl ? { realWebsite: context.legalBrandUrl } : {}),
	}),
	external: {
		prepare: prepareNameSiloExternalSubmission,
		submit: submitNameSiloSubmission,
	},
});
