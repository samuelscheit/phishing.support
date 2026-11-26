import { defineProvider } from "../kit/provider";
import { fetchEranetCorrespondence } from "./correspondence";
import { submitEranetSupplement } from "./supplement";
import { ERANET_PROVIDER } from "./definition";
import { makeEranetDescription } from "./payload";
import { reportAccess } from "../kit/report_payload";
import { eranetDraft, prepareEranetExternalSubmission, submitEranetSubmission } from "./submission";

/** Eranet (IANA 1868) takes abuse reports through its own form, gated by a mailed code. */
export const eranetProvider = defineProvider({
	definition: ERANET_PROVIDER,
	draft: eranetDraft,
	preview: (context) => makeEranetDescription({
		target: context.target,
		observedUrl: context.observedUrls[0],
		description: context.description,
		...reportAccess(context),
		...(context.allegationCategory ? { allegationCategory: context.allegationCategory } : {}),
		...(context.legalBrandUrl ? { legalBrandUrl: context.legalBrandUrl } : {}),
	}),
	// The code lives in the preflight's browser session.
	external: { prepare: prepareEranetExternalSubmission, submit: submitEranetSubmission },
	// Eranet answers in its portal; its mails only say that the status changed.
	inbound: { senderDomains: ["eranet.com"], confirmationIds: null },
	fetchCorrespondence: fetchEranetCorrespondence,
	// "Submitted" and "material auditing" are its queue; "processing" means it confirmed the abuse.
	reviewVerdicts: { "supplement required": "needs_more_information", processing: "acknowledged", "process completed": "acknowledged" },
	decisionOf: ({ state }) => state === "processing" ? { outcome: "received", label: "Abuse confirmed, in progress" }
		: state === "submitted" || state === "material auditing" ? { outcome: "received", label: "Under review" }
		: undefined,
	channel: "web form",
	// "Supplement required": Eranet could not confirm the abuse from the report and waits on more material.
	decisionFollowUp: {
		contestedStates: ["supplement required"],
		addressee: "Eranet",
		channel: {
			kind: "form",
			name: "Eranet's supplement form",
			requirements: "The form takes plain text and requires at least one screenshot (PNG, JPG or GIF, up to 8 MB, at most 12).",
			submit: submitEranetSupplement,
		},
	},
});
