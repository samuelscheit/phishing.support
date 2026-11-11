import { serviceIdentity } from "../../../constants";
import { hashStableJson } from "../../security";
import type { MailedCodeSpec } from "../mailed_code";
import type { ProviderSubmissionDefinition } from "../submission_contracts";

/** The complaint types this service files: the form's `lx` values. */
export type GnameComplaintKind = "phishing" | "malware";

export type GnameComplaintType = {
	/** The form's `lx`. */
	lx: number;
	/** The form page that offers the type. */
	pageUrl: string;
	/** The form's caption for the type, as the report names it. */
	caption: string;
	/** Whether the form asks for the legitimate site a phishing page imitates (`wzdz`). */
	legalBrandUrl: boolean;
};

export type GnameProviderDefinition = ProviderSubmissionDefinition & {
	origin: string;
	complaintTypes: Readonly<Record<GnameComplaintKind, GnameComplaintType>>;
	/** The form's own slider before it mails a code: GnSliderVerify, scored at `/request/slideverify`. */
	slider: { handle: string; rail: string };
	codeMail: MailedCodeSpec;
	evidence: {
		acceptedMimeTypes: readonly ["image/png", "image/jpeg"];
		maximumBytes: number;
	};
	/** `sm`: "1-1000 digits". */
	maximumDescriptionLength: number;
	reporter: { name: string; email: string };
};

/** Accredited GNAME registrar IDs, reviewed against IANA registrar data. */
const GNAME_REGISTRAR_IDS = Object.freeze([
	1923,
	...range(3941, 3950),
	...range(3980, 4019),
	...range(4043, 4142),
	...range(4164, 4312),
	...range(4343, 4542),
]);

function range(start: number, end: number): number[] {
	return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

/**
 * Code-owned contract for GNAME's abuse complaint form (www.gname.com/abuse),
 * read from its page and `lyts.js` on 2026-11-07. GNAME's RDAP names
 * complaint@gname.com; the form is its documented channel and returns a
 * case number. A complaint needs a mailed code, and the code is sent only
 * after the form's behavioural slider passes. Phishing is "Set up phishing
 * and fraud site" (category 2); the form has no malware type, so malware is
 * "Other issue" (category 4).
 */
const definitionWithoutHash = {
	key: "gname",
	displayName: "GNAME Abuse Complaint",
	version: "2026-11-07.1",
	exactMailboxes: ["complaint@gname.com"],
	registrarIds: [...GNAME_REGISTRAR_IDS],
	supplemental: false,
	origin: "https://www.gname.com",
	complaintTypes: {
		phishing: { lx: 8, pageUrl: "https://www.gname.com/abuse/category/2", caption: "Set up phishing and fraud site", legalBrandUrl: true },
		malware: { lx: 7, pageUrl: "https://www.gname.com/abuse/category/4", caption: "Other issue", legalBrandUrl: false },
	},
	slider: { handle: ".gn-slide-bar", rail: ".gn-slide-rail" },
	codeMail: {
		provider: "GNAME",
		// gname.com/help/396.html: its system mail comes from gname@gname.net,
		// gname@gname.vip, and noreply@share-dns.net. The code mail of
		// 2026-11-07 came from gname@gname.net through Aliyun DirectMail.
		senderDomains: ["gname.net", "gname.vip", "share-dns.net"],
		// "GNAME: Verify your email address"
		subjectPattern: "verify your email",
		// "Here's your verification code: <strong>752253</strong>"
		codePattern: "verification code:?\\s*(\\d{6})\\b",
		maxAgeMs: 10 * 60_000,
		waitMs: 4 * 60_000,
	},
	evidence: {
		acceptedMimeTypes: ["image/png", "image/jpeg"] as const,
		maximumBytes: 2 * 1024 * 1024,
	},
	maximumDescriptionLength: 1_000,
	reporter: { name: serviceIdentity.name, email: serviceIdentity.mailbox },
};

export const GNAME_PROVIDER: GnameProviderDefinition = Object.freeze({
	...definitionWithoutHash,
	contentHash: hashStableJson(definitionWithoutHash),
});
