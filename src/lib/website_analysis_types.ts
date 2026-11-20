import type { archiveWebsite } from "./website_archive";
import type { BareVisitDependencies } from "./website_access_gate";
import type { AnalysisClient } from "./analysis_run";
import type { timestampEvidence } from "./evidence/timestamp";
import type { LookupResult } from "./exfiltration/downloads/policy";
import type { VisitAgent } from "./site_visit/agent";
import type { DomainRegistrationLookup } from "./domain_registration";
import type { getInfo } from "./website_info";
import type { VisitDataSent, WebsiteOfferedDownload } from "./website_types";

export type WebsiteCapture = Awaited<ReturnType<typeof archiveWebsite>> & { offeredDownload?: WebsiteOfferedDownload; dataSent?: VisitDataSent[] };

/** Network boundaries of one website analysis; tests replace them. */
export type WebsiteAnalysisDependencies = {
	getInfo?: typeof getInfo;
	archiveWebsite?: typeof archiveWebsite;
	analysisClient?: AnalysisClient;
	/** Waits between capture attempts after a browser-service failure. */
	browserBackoffMs?: readonly number[];
	/** The RFC 3161 authority call that timestamps the evidence manifest. */
	timestampEvidence?: typeof timestampEvidence;
	/** What malware scanners say about an offered file's hash. */
	downloadLookups?: (sha256: string) => Promise<LookupResult[]>;
	/** The agent that walks the site; the browser task agent in production. */
	visitAgent?: VisitAgent;
	/** How long after its first walk began a flow its destination cloaked may be walked again through another network. */
	cloakedFlowBudgetMs?: number;
	/** The request that checks what a gated page shows a visitor without its session. */
	bareVisit?: BareVisitDependencies;
	/** Who holds the domain a page is on, for the classifier to tell a brand's own site from a lookalike. */
	domainRegistration?: DomainRegistrationLookup;
};
