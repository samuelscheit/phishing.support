import { normalizeDomain } from "../../security";
import { reportReferencesIn } from "../report_reference";
import type {
	ProviderInboundMail,
	ProviderReportPreviewContext,
	ProviderSubmissionContext,
	ProviderSubmissionDefinition,
	ProviderSubmissionPreflight,
	ProviderSubmissionPreparation,
	ProviderSubmissionProvider,
	ProviderSubmissionSuccess,
} from "../submission_contracts";
import type { ReportInput } from "./draft";

/** Every preview carries this stand-in for the route's reference. */
export const PREVIEW_REFERENCE = "PS-000000000000-R0";

/** The preview of a registrar-style provider: the domain, its listed URLs and the free text a draft would send. */
export function registrarPreview(rules: {
	urls: (domain: string, observedUrls: readonly string[]) => string[];
	make: (input: ReportInput, urls: readonly string[]) => string | undefined;
}): (context: ProviderReportPreviewContext) => string | undefined {
	return (context) => {
		const domain = normalizeDomain(context.target);
		const urls = domain ? rules.urls(domain, context.observedUrls) : [];
		return domain && urls.length > 0 ? rules.make({
			target: domain,
			observedUrls: context.observedUrls,
			description: context.description,
			...(context.allegationCategory ? { allegationCategory: context.allegationCategory } : {}),
			legalBrandUrl: context.legalBrandUrl ?? null,
			trackingId: PREVIEW_REFERENCE,
		}, urls) : undefined;
	};
}

type Rest = Pick<ProviderSubmissionProvider, "fetchCorrespondence" | "findSubmission" | "reviewVerdicts" | "decisionFollowUp">;

/**
 * Wire a direct provider: a browser or form provider's `external` pair fills
 * `prepareExternalSubmission`, `submit` and `submitPrepared` (the executor
 * always calls the latter), and the mail defaults are what registrar replies are.
 */
export function defineProvider(spec: Rest & {
	definition: ProviderSubmissionDefinition;
	prepare: (context: ProviderSubmissionContext) => Promise<ProviderSubmissionPreparation>;
	preview?: ProviderSubmissionProvider["buildReportPreview"];
	external?: {
		prepare: (context: ProviderSubmissionContext) => Promise<ProviderSubmissionPreflight>;
		submit: (context: ProviderSubmissionContext, preflight: ProviderSubmissionPreflight | undefined) => Promise<ProviderSubmissionSuccess>;
	};
	/** The irreversible call of a provider without a preflight. */
	submit?: ProviderSubmissionProvider["submit"];
	inbound?: Omit<ProviderInboundMail, "confirmationIds"> & Partial<Pick<ProviderInboundMail, "confirmationIds">>;
}): ProviderSubmissionProvider {
	const { prepare, preview, external, submit, inbound, ...rest } = spec;
	const submitCall = external ? (context: ProviderSubmissionContext) => external.submit(context, undefined) : submit;
	if (!submitCall) throw new Error(`${spec.definition.key} has no submit call.`);
	return {
		...rest,
		prepareSubmission: prepare,
		...(preview ? { buildReportPreview: preview } : {}),
		...(external ? { prepareExternalSubmission: external.prepare, submitPrepared: external.submit } : {}),
		submit: submitCall,
		...(inbound ? { inboundMail: { confirmationIds: reportReferencesIn, ...inbound } } : {}),
	};
}
