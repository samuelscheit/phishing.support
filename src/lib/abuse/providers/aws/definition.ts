import { serviceIdentity } from "../../../constants";
import { definePinned } from "../kit/pin";

const [firstName = serviceIdentity.name, ...lastName] = serviceIdentity.name.split(" ");

/**
 * Code-owned contract for AWS's public abuse web form ("Report abuse" in the
 * AWS Support Center). AWS answers mail to its abuse mailboxes with "please
 * consider submitting future reports via our new web forms"; the form needs no
 * login, captcha or cookies, so the route posts the same JSON it does.
 */
export const AWS_PROVIDER = definePinned({
	key: "aws_trust_safety",
	displayName: "AWS Trust & Safety",
	version: "2026-11-20.2",
	exactMailboxes: ["trustandsafety@support.aws.com", "abuse@amazonaws.com"],
	supplemental: false,
	/** The abuse form's API; the page at `formUrl` posts the same request unauthenticated. */
	endpoint: "https://api.support.aws.amazon.com/v1/contacts/report-abuse-v2",
	/** The `origin` the form's own requests carry. */
	origin: "https://support.aws.amazon.com",
	formUrl: "https://support.aws.amazon.com/#/contacts/report-abuse",
	abuseSource: "aws-owned-resource" as const,
	abuseGroup: "web_content" as const,
	/** The form's "Email" category, for the host that sent a phishing email. */
	emailAbuseGroup: "email" as const,
	/** The email category offers only `spam_send` ("Sending email spam") and `spam-website`; the sender is the first. */
	emailAbuseType: "spam_send" as const,
	/** The form's `email_header` ("Complete email header and body") holds at most this many characters. */
	emailHeaderMaximumLength: 10_000,
	/** The form's "abuse type" per allegation. */
	abuseTypes: { phishing: "phishing", malware: "malware-website" },
	/** The form's URL field holds at most this many URLs, each of at most `urlMaximumLength` characters. */
	maximumUrls: 10,
	urlMaximumLength: 1_024,
	commentsMaximumLength: 10_000,
	/** The report narrative's share of the comments; the rest holds the reference, case page and preservation request. */
	narrativeMaximumLength: 3_000,
	trackingIdMaximumLength: 50,
	timeoutMs: 30_000,
	reporter: {
		firstName,
		lastName: lastName.join(" "),
		email: serviceIdentity.mailbox,
		phone: "",
		organization: serviceIdentity.name,
		description: "independent-researcher",
	},
});

