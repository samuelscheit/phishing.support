import { FaviconStore, isFaviconDomain } from "@/lib/favicon/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Nothing in an icon response may run, load or be read as anything but the PNG it is. */
const HARDENED = {
	"x-content-type-options": "nosniff",
	"content-security-policy": "default-src 'none'",
	"cross-origin-resource-policy": "same-origin",
} as const;

const notFound = () => new Response("Not found", { status: 404, headers: { ...HARDENED, "cache-control": "no-store" } });

/**
 * A provider website's icon from our own origin, so a visitor's browser
 * never asks the provider's site. Only stored icons are served; this never
 * fetches. The page links the icon with its version, and that URL never
 * changes content: it is cached for a year. An outdated or missing version
 * gets the current icon briefly cached; a domain without one is 404, and
 * the page shows the initials instead.
 */
export async function GET(request: Request, { params }: { params: Promise<{ domain: string }> }) {
	let domain: string;
	try {
		domain = decodeURIComponent((await params).domain);
	} catch {
		return notFound();
	}
	if (!isFaviconDomain(domain)) return notFound();
	const icon = await FaviconStore.served(domain);
	if (!icon) return notFound();
	const current = new URL(request.url).searchParams.get("v") === icon.version;
	return new Response(new Uint8Array(icon.png!), {
		headers: {
			...HARDENED,
			"content-type": "image/png",
			"content-length": String(icon.png!.length),
			etag: `"${icon.version}"`,
			"cache-control": current ? "public, max-age=31536000, immutable" : "public, max-age=3600",
		},
	});
}
