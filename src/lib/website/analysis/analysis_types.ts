import type { visitSite } from "../archive/visit_site";
import type { WebsiteArchiveResult } from "../archive/types";
import type { BareVisitDependencies } from "../visit/access_gate";
import type { AnalysisClient } from "../../analysis/run";
import type { timestampEvidence } from "../../evidence/timestamp";
import type { LookupResult } from "../../exfiltration/downloads/policy";
import type { VisitAgent } from "../../site_visit/agent";
import type { DomainRegistrationLookup } from "../info/domain_registration";
import type { getInfo } from "../info/info";
import type { VisitDataSent, WebsiteOfferedDownload } from "../types";
import type { ClipboardWrite } from "../../browser/clipboard";
import type { PopularDomains } from "../../abuse/origin/popular_domains";

export type WebsiteCapture = WebsiteArchiveResult & { offeredDownload?: WebsiteOfferedDownload; dataSent?: VisitDataSent[]; clipboardWrites?: ClipboardWrite[] };

/** Network boundaries of one website analysis; tests replace them. */
export type WebsiteAnalysisDependencies = {
	/** The visit job's: aborted, the visit ends at its next step and leaves the case to the job's recovery. */
	signal?: AbortSignal;
	getInfo?: typeof getInfo;
	/** The browser visit of the site: loads it, captures its first page and walks on. */
	visitSite?: typeof visitSite;
	analysisClient?: AnalysisClient;
	/** Waits between attempts to load the site after a browser-service failure. */
	browserBackoffMs?: readonly number[];
	/** The RFC 3161 authority call that timestamps the evidence manifest. */
	timestampEvidence?: typeof timestampEvidence;
	/** What malware scanners say about an offered file's hash. */
	downloadLookups?: (sha256: string) => Promise<LookupResult[]>;
	/** The agent that walks the site; the browser task agent in production. */
	visitAgent?: VisitAgent;
	/** How long after its first walk began a flow its destination cloaked may be walked again through another network. */
	cloakedFlowBudgetMs?: number;
	/** How long after the first walk a rotating link's other offers may still be sampled (`ROTATION_BUDGET_MS`). */
	rotationBudgetMs?: number;
	/** The request that checks what a gated page shows a visitor without its session. */
	bareVisit?: BareVisitDependencies;
	/** Who holds the domain a page is on, for the classifier to tell a brand's own site from a lookalike. */
	domainRegistration?: DomainRegistrationLookup;
	/** The well-known sites (Tranco top list) a deceptive funnel's report treats with care. */
	popularDomains?: () => Promise<PopularDomains>;
};
