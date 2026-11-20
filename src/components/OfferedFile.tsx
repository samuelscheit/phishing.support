import type { WebsiteOfferedDownload } from "@/lib/website/types";

/** The file a page offered: its name and size, as the notes about the visit's download name it. */
export function OfferedFile({ download }: { download: Pick<WebsiteOfferedDownload, "fileName" | "sizeBytes"> }) {
	return <><span className="font-mono">{download.fileName}</span> ({download.sizeBytes.toLocaleString()} bytes)</>;
}
