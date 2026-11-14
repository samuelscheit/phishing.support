/** The public origin every canonical URL, sitemap entry, and share card points at. */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://phishing.support").replace(/\/+$/, "");

export const SITE_NAME = "Phishing Support";

/** One sentence that says what the site does, for search results and share cards. */
export const SITE_DESCRIPTION =
	"Forward a phishing email or paste a suspicious link: Phishing Support analyzes it and reports confirmed phishing to the domain registrar, the hosting provider, and takedown services.";

export const absoluteUrl = (path: string) => `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
