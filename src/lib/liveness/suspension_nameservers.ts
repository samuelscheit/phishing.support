/**
 * Nameserver domains a registrar or registry delegates a suspended domain to.
 * A domain delegated there is down at the registry, whatever a resolver that
 * still holds the old delegation answers. Only ones confirmed from public
 * sources are listed; a nameserver matches when it is one of these domains or
 * a host below it.
 */
export const SUSPENSION_NAMESERVER_DOMAINS: readonly string[] = [
	// Observed in production 2026-11-20: nodeagent.pro, suspended 13:38 UTC after a Cloudflare report;
	// registry RDAP (Identity Digital) showed ns1/ns2.domain-suspended.com and only "client transfer prohibited".
	"domain-suspended.com",
	// ns1/ns2 and ns1.verification-hold.suspended-domain.com: registrar/registry suspension, e.g. an unverified
	// registrant e-mail (https://portal.hostbreak.com/knowledgebase/4221/Domain-Suspension.html,
	// https://support.regway.com/knowledgebase.php?article=2, https://who.is/nameserver/ns1.suspended-domain.com).
	"suspended-domain.com",
	// GoDaddy's abuse suspension, ns1/ns2.suspended-for.spam-and-abuse.com
	// (https://www.whois.com/whois/spam-and-abuse.com, https://www.thedomains.com/2012/02/21/over-225000-domain-names-are-on-godaddy-owned-spam-and-abuse-com-like-jotform-com-was/).
	"spam-and-abuse.com",
	// Hostinger's suspension, ns1/ns2.dns-suspended.com (https://www.who.is/dns-report/dns-report-2026-09-18).
	"dns-suspended.com",
];

/** The first of the delegated nameservers that is a suspension nameserver. */
export function suspensionNameserver(nameservers: readonly string[]): string | undefined {
	return nameservers.find((nameserver) => {
		const host = nameserver.toLowerCase().replace(/\.$/, "");
		return SUSPENSION_NAMESERVER_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
	});
}
