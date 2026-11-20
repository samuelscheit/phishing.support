import { defineProvider } from "../kit/provider";
import { NAMESILO_PROVIDER } from "./definition";
import { makeNameSiloExplanation } from "./payload";
import { prepareNameSiloExternalSubmission, prepareNameSiloSubmission, submitNameSiloSubmission } from "./submission";

/** NameSilo owns its exact mailboxes, form contract, CSRF state, and upload. */
export const nameSiloProvider = defineProvider({
	definition: NAMESILO_PROVIDER,
	prepare: prepareNameSiloSubmission,
	preview: (context) => makeNameSiloExplanation({
		target: context.target,
		observedUrl: context.observedUrls[0],
		description: context.description,
		...(context.allegationCategory ? { allegationCategory: context.allegationCategory } : {}),
		...(context.legalBrandUrl ? { realWebsite: context.legalBrandUrl } : {}),
	}),
	external: {
		prepare: prepareNameSiloExternalSubmission,
		submit: (context, preflight) => submitNameSiloSubmission(context, {}, preflight),
	},
});
