import { defineProvider } from "../kit/provider";
import { NETCRAFT_MAIL_PROVIDER } from "./definition";
import { netcraftMailDraft, prepareNetcraftMailExternalSubmission, submitNetcraftMailSubmission } from "./submission";
import { NETCRAFT_INBOUND_MAIL } from "../netcraft/inbound";
import { fetchNetcraftCorrespondence, NETCRAFT_REVIEW_VERDICTS } from "../netcraft/correspondence";

/** Supplemental Netcraft route that files the reported phishing message itself. */
export const netcraftMailProvider = defineProvider({
	definition: NETCRAFT_MAIL_PROVIDER,
	draft: netcraftMailDraft,
	preview: () => "The recipient-redacted original phishing email (RFC 822 source) is submitted to Netcraft's mail-report API.",
	inbound: NETCRAFT_INBOUND_MAIL,
	external: { prepare: prepareNetcraftMailExternalSubmission, submit: submitNetcraftMailSubmission },
	fetchCorrespondence: fetchNetcraftCorrespondence,
	reviewVerdicts: NETCRAFT_REVIEW_VERDICTS,
});
