/**
 * What every takedown report asks of the provider besides the takedown:
 * suspend instead of delete, and keep the records police will ask for.
 * Only an authority can compel preservation, but a provider that deletes an
 * account at once destroys the records a later request needs, and most
 * honour this ask (see docs/research/criminal-referral-routes.md).
 */
export const PRESERVATION_REQUEST =
	"Please suspend rather than delete the account and its content, and retain the account, payment and access-log data for at least 90 days: confirmed phishing operations are referred to law enforcement, and a request for these records may follow.";

/** The same ask for a provider form's short free-text field. */
export const PRESERVATION_REQUEST_SHORT =
	"Please suspend rather than delete, and keep account, payment and access-log data for 90 days for law enforcement.";
