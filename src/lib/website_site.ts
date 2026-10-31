/**
 * Hosts that serve many unrelated sites under one hostname. Each site is owned
 * by whoever controls a leading path prefix, so the hostname alone would merge
 * every tenant into one case. Subdomain-based platforms (github.io, pages.dev,
 * …) need no entry: their tenants already have their own hostnames.
 */
type PathTenantRule = {
	/** Leading path segments that name one tenant. */
	segments: number | ((path: readonly string[]) => number);
	/** Whether the platform treats the tenant path case-insensitively. */
	caseInsensitive?: boolean;
};

/** One opaque code per link: `/<code>`. */
const SHORT_LINK: PathTenantRule = { segments: 1 };

const PATH_TENANT_HOSTS: Record<string, PathTenantRule> = {
	// `/view/<site>`, `/<workspace-domain>/<site>`, legacy `/site/<site>`.
	"sites.google.com": { segments: 2, caseInsensitive: true },
	// `/forms/d/<id>`, `/document/d/<id>`, and published `/forms/d/e/<id>`.
	"docs.google.com": { segments: (path) => (path[1] === "d" ? (path[2] === "e" ? 4 : 3) : 1) },
	// `/file/d/<id>`, `/drive/folders/<id>`.
	"drive.google.com": { segments: 3 },
	// `/macros/s/<deployment>`.
	"script.google.com": { segments: 3 },
	// `/<bucket>` and `/v0/b/<bucket>`.
	"storage.googleapis.com": { segments: 1 },
	"firebasestorage.googleapis.com": { segments: 3 },
	"s3.amazonaws.com": { segments: 1 },
	// `/<user>`.
	"github.com": { segments: 1, caseInsensitive: true },
	"gist.github.com": { segments: 1, caseInsensitive: true },
	"raw.githubusercontent.com": { segments: 1, caseInsensitive: true },
	"gitlab.com": { segments: 1, caseInsensitive: true },
	// `/ipfs/<cid>`.
	"ipfs.io": { segments: 2 },
	"cloudflare-ipfs.com": { segments: 2 },
	"t.me": { segments: 1, caseInsensitive: true },
	"linktr.ee": { segments: 1, caseInsensitive: true },
	"telegra.ph": { segments: 1 },
	"bit.ly": SHORT_LINK,
	"tinyurl.com": SHORT_LINK,
	"t.co": SHORT_LINK,
	"goo.gl": SHORT_LINK,
	"forms.gle": SHORT_LINK,
	"is.gd": SHORT_LINK,
	"cutt.ly": SHORT_LINK,
	"rb.gy": SHORT_LINK,
	"t.ly": SHORT_LINK,
	"ow.ly": SHORT_LINK,
	"tiny.cc": SHORT_LINK,
	"shorturl.at": SHORT_LINK,
	"s.id": SHORT_LINK,
	"qrco.de": SHORT_LINK,
};

export function hasPathTenants(hostname: string): boolean {
	return Object.hasOwn(PATH_TENANT_HOSTS, hostname);
}

/**
 * The site a URL belongs to: its hostname, extended by the owning path prefix
 * on a shared host (`sites.google.com/view/<site>`). One site is one case and
 * one reported target; two sites never share either.
 */
export function websiteSite(url: string | URL): string {
	const parsed = typeof url === "string" ? new URL(url) : url;
	const rule = PATH_TENANT_HOSTS[parsed.hostname];
	if (!rule) return parsed.hostname;
	const path = parsed.pathname.split("/").filter(Boolean);
	const tenant = path.slice(0, typeof rule.segments === "number" ? rule.segments : rule.segments(path)).join("/");
	if (!tenant) return parsed.hostname;
	return `${parsed.hostname}/${rule.caseInsensitive ? tenant.toLowerCase() : tenant}`;
}

export function isSameWebsite(a: string | URL, b: string | URL): boolean {
	return websiteSite(a) === websiteSite(b);
}

/** The site of a stored URL for display, or null when it does not parse. */
export function websiteSiteName(rawUrl: string | undefined): string | null {
	if (!rawUrl) return null;
	try {
		return websiteSite(rawUrl);
	} catch {
		return null;
	}
}
