/**
 * The natural person who files criminal complaints for phishing.support.
 * An authority gives a file number and answers only a named complainant, so
 * every referral is signed by this person; nothing is sent without it.
 */
import { OperatorActionError } from "../abuse/approval/drafted_mail";

export type Complainant = {
	name: string;
	/** Postal address lines, as written under the signature. */
	addressLines: string[];
	phone?: string;
};

export class ComplainantNotConfiguredError extends OperatorActionError {
	constructor() {
		super("REFERRAL_COMPLAINANT_NAME and REFERRAL_COMPLAINANT_ADDRESS must be set before a criminal referral can be drafted.");
		this.name = "ComplainantNotConfiguredError";
	}
}

/** `REFERRAL_COMPLAINANT_ADDRESS` separates lines with `;` or a newline: "Musterstraße 1; 85609 Aschheim". */
export function configuredComplainant(env: Record<string, string | undefined> = process.env): Complainant {
	const name = env.REFERRAL_COMPLAINANT_NAME?.trim();
	const addressLines = (env.REFERRAL_COMPLAINANT_ADDRESS ?? "").split(/[;\n]/).map((line) => line.trim()).filter(Boolean);
	if (!name || addressLines.length === 0) throw new ComplainantNotConfiguredError();
	const phone = env.REFERRAL_COMPLAINANT_PHONE?.trim();
	return { name, addressLines, ...(phone ? { phone } : {}) };
}
