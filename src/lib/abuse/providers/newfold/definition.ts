import { serviceIdentity } from "../../../constants";
import { hashStableJson } from "../../security";
import type { ProviderSubmissionDefinition } from "../submission_contracts";

export type NewfoldProviderDefinition = ProviderSubmissionDefinition & {
	formUrl: string;
	/** The abuse form (`<form action="/bin/newfold/lead">`; its id is renamed by the page's script). */
	formSelector: string;
	/** The servlet the form's native submit posts multipart to. */
	leadUrl: string;
	/** Matches the form's four constant hidden inputs. */
	hiddenFieldPattern: string;
	/** Their values; the page must still render exactly these, and the filing request sends exactly these. */
	hiddenFields: readonly (readonly [name: string, value: string])[];
	fields: { firstName: string; lastName: string; email: string; url: string; inquiryType: string; brand: string; comments: string; attachment: string; agreement: string; recaptcha: string };
	/** `ABUSE-FORM-0008`: "Phishing". */
	inquiryType: string;
	agreement: string;
	/** What the form's `brand` select offers; the brand picks the CRM queue the case lands in. */
	brands: readonly string[];
	/** The brand when nothing names one ("Other"). */
	defaultBrand: string;
	/** Brand by the exact abuse mailbox that selected the route. */
	brandByMailbox: Readonly<Record<string, string>>;
	/** Brand by the IANA registrar ID that selected the route. */
	brandByRegistrarId: Readonly<Record<number, string>>;
	captcha: { type: 4; siteKey: string; pageUrl: string };
	/** The page the servlet redirects to after it created the case (the `thankyou` hidden field). */
	thankYouPath: string;
	commentsMaximumLength: number;
	/** The comments' share for the reported URLs. */
	urlsMaximumLength: number;
	urlMaximumLength: number;
	maximumUrls: number;
	hostingLineMaximumLength: number;
	/** Below this the narrative has no room and the comments are not drafted. */
	narrativeMinimumLength: number;
	/** The form's attachment: one file, at most 1 MiB. */
	evidence: { acceptedMimeTypes: readonly ["image/png", "image/jpeg"]; maximumBytes: number };
	timeoutMs: number;
	reporter: { firstName: string; lastName: string; email: string };
};

const [firstName = "", ...lastNameParts] = serviceIdentity.name.split(" ");

/**
 * Code-owned contract for Newfold Digital's abuse form (docs/providers/newfold.md).
 * Newfold's mailboxes are not monitored; the form (Cloudflare in front, a
 * reCAPTCHA v2 checkbox) is the one channel for every brand it covers. Brands
 * and IANA IDs: Network Solutions 2, Register.com 9 and Domain.com 886 are
 * registrars of Newfold (RDAP of networksolutions.com, register.com, bluehost.com).
 * The mailboxes are the abuse and network contacts public ARIN RDAP names for
 * Newfold's hosting networks (Unified Layer/Bluehost AS46606, HostGator,
 * Web.com/Network Solutions) and the registrars' RDAP abuse contact.
 */
const definitionWithoutHash = {
	key: "newfold",
	displayName: "Newfold Digital",
	version: "2026-11-21.1",
	exactMailboxes: ["abuse@bluehost.com", "abuse@unifiedlayer.com", "iarpoc@newfold.com", "net-eng-team@newfold.com", "domain.operations@web.com"],
	registrarIds: [2, 9, 886],
	supplemental: false,
	formUrl: "https://www.newfold.com/abuse",
	formSelector: 'form[action="/bin/newfold/lead"]',
	leadUrl: "https://www.newfold.com/bin/newfold/lead",
	hiddenFieldPattern: "^(inquiryEmail|newfoldAbuse|requestJSONPath|thankyou)$",
	hiddenFields: [
		["inquiryEmail", "abuse-trademark@newfold.com"],
		["newfoldAbuse", "newfoldAbuse"],
		["requestJSONPath", "/content/dam/newfold/esb/abuse.json"],
		["thankyou", "https://www.newfold.com/thank-you"],
	] as const,
	fields: {
		firstName: "firstName",
		lastName: "lastName",
		email: "email",
		url: "url",
		inquiryType: "inquiryType",
		brand: "brand",
		comments: "comments",
		attachment: "attachment",
		agreement: "agreementStatement",
		recaptcha: "g-recaptcha-response",
	},
	inquiryType: "ABUSE-FORM-0008",
	agreement: "on",
	brands: [
		"808-accountsupport", "287-arvixe", "288-aso", "800-bluehost", "160-crazydomains", "Domain.com", "172-dreamscape", "163-freeparking", "Homestead",
		"150-hostgator", "258-hostyoursite", "250-ipage", "100-namejet", "300-namesecure", "Netfirms", "100-networksolutions.com", "200-register.com",
		"292-sites", "100-snapnames", "300-srsplus", "170-vodien", "300-web.com", "279-yourwebhosting", "100-other",
	] as const,
	defaultBrand: "100-other",
	brandByMailbox: {
		"abuse@bluehost.com": "800-bluehost",
		"abuse@unifiedlayer.com": "800-bluehost",
		"net-eng-team@newfold.com": "300-web.com",
		"domain.operations@web.com": "300-web.com",
	},
	brandByRegistrarId: { 2: "100-networksolutions.com", 9: "200-register.com", 886: "Domain.com" },
	captcha: { type: 4 as const, siteKey: "6Lc2vj8lAAAAAF4yi77gg_-kxh2q4FyIBHUK9pES", pageUrl: "https://www.newfold.com/abuse" },
	thankYouPath: "/thank-you",
	commentsMaximumLength: 1_000,
	urlsMaximumLength: 300,
	urlMaximumLength: 200,
	maximumUrls: 5,
	hostingLineMaximumLength: 200,
	narrativeMinimumLength: 250,
	evidence: { acceptedMimeTypes: ["image/png", "image/jpeg"] as const, maximumBytes: 1_048_576 },
	timeoutMs: 60_000,
	reporter: { firstName, lastName: lastNameParts.join(" ") || firstName, email: serviceIdentity.mailbox },
};

export const NEWFOLD_PROVIDER: NewfoldProviderDefinition = Object.freeze({
	...definitionWithoutHash,
	contentHash: hashStableJson(definitionWithoutHash),
});
