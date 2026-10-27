import { netcraftSubmissionIdsFromText } from "../../../netcraft/api";
import type { ProviderInboundMail } from "../submission_contracts";

/** Netcraft's report-update emails name the submission they are about in their result links. */
export const NETCRAFT_INBOUND_MAIL: ProviderInboundMail = {
	senderDomains: ["netcraft.com"],
	confirmationIds: netcraftSubmissionIdsFromText,
};
