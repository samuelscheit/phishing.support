import { defineProvider } from "../kit/provider";
import { TENCENT_PROVIDER } from "./definition";
import { makeTencentExplanation } from "./payload";
import { prepareTencentExternalSubmission, tencentDraft, submitTencentSubmission } from "./submission";

/** Tencent owns its DNS-abuse mailbox selection, evidence rules, and browser form. */
export const tencentProvider = defineProvider({
	definition: TENCENT_PROVIDER,
	draft: tencentDraft,
	preview: (context) => makeTencentExplanation({
		target: context.target,
		observedUrl: context.observedUrls[0],
		description: context.description,
		...(context.allegationCategory ? { allegationCategory: context.allegationCategory } : {}),
		...(context.legalBrandUrl ? { legalBrandUrl: context.legalBrandUrl } : {}),
	}),
	external: { prepare: prepareTencentExternalSubmission, submit: submitTencentSubmission },
});
