import { getDomain } from "tldts";

import { cn } from "@/web_lib/util";

/**
 * A web address as a careful reader should read it: only the registered
 * domain stands out; protocol, subdomain and path are muted, because the
 * domain is the part that tells a real site from a fake one. Paths break
 * only after a "/". `bare` shows the host alone.
 */
export function Address({ url, className, bare = false }: { url: string; className?: string; bare?: boolean }) {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return <span className={cn("font-mono text-muted-foreground", className)}>{url || "about:blank"}</span>;
	}
	const domain = getDomain(parsed.hostname, { allowPrivateDomains: false }) ?? parsed.hostname;
	const subdomain = parsed.host.slice(0, parsed.host.length - domain.length - (parsed.port ? parsed.port.length + 1 : 0));
	const rest = `${parsed.pathname}${parsed.search}${parsed.hash}`;
	return (
		<span className={cn("font-mono", className)}>
			<span className="whitespace-nowrap">
				<span className="text-muted-foreground">{bare ? "" : `${parsed.protocol}//`}{subdomain}</span>
				<span className="font-semibold text-foreground">{domain}</span>
				{parsed.port && <span className="text-muted-foreground">:{parsed.port}</span>}
			</span>
			{!bare && (
				<span className="text-muted-foreground">
					{rest.split("/").map((part, index) => <span key={index}>{index ? <>/<wbr /></> : null}{part}</span>)}
				</span>
			)}
		</span>
	);
}
