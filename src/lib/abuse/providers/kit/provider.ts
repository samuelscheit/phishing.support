import { normalizeDomain } from "../../security/security";
import { reportReferencesIn } from "./report_reference";
import type {
	ProviderInboundMail,
	ProviderReportPreviewContext,
	ProviderSubmissionContext,
	ProviderSubmissionDefinition,
	ProviderSubmissionFiling,
	ProviderSubmissionPreflight,
	ProviderSubmissionPreparation,
	ProviderSubmissionProvider,
	ProviderSubmissionSuccess,
} from "../submission_contracts";
import type { ReportInput, Verified } from "./draft";

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

type Rest = Pick<ProviderSubmissionProvider, "fetchCorrespondence" | "findSubmission" | "reportedUrls" | "reviewVerdicts" | "decisionFollowUp" | "decisionOf" | "channel">;

type Filing<Payload> =
	| {
		/** The irreversible call of a provider without a preflight. */
		submit: (context: ProviderSubmissionContext) => Promise<ProviderSubmissionSuccess>;
		external?: undefined;
	}
	| {
		/** The provider's preflight before the marker, given what the executor verified, and the irreversible call that consumes it. */
		external: {
			prepare: (context: ProviderSubmissionContext, verified: Verified<Payload>) => Promise<ProviderSubmissionPreflight>;
			submit: (context: ProviderSubmissionContext, preflight: ProviderSubmissionPreflight) => Promise<ProviderSubmissionSuccess>;
		};
		submit?: undefined;
	};

/**
 * Wire a direct provider from its draft pair and its filing; the mail
 * defaults are what registrar replies are.
 */
export function defineProvider<Payload>(spec: Rest & Filing<Payload> & {
	definition: ProviderSubmissionDefinition;
	/** `createDraft`'s pre-marker pair: the executor prepares with it and verifies with it before the marker. */
	draft: {
		prepare: (context: ProviderSubmissionContext) => Promise<ProviderSubmissionPreparation>;
		verify: (context: ProviderSubmissionContext) => Promise<Verified<Payload>>;
	};
	preview?: ProviderSubmissionProvider["buildReportPreview"];
	/** `confirmationIds: null` when the provider's API is the authoritative record, so its mail is not attached a second time. */
	inbound?: Omit<ProviderInboundMail, "confirmationIds"> & { confirmationIds?: ProviderInboundMail["confirmationIds"] | null };
}): ProviderSubmissionProvider {
	const { draft, preview, external, submit, inbound, ...rest } = spec;
	const filing: ProviderSubmissionFiling = external
		? { prepareExternalSubmission: (context, verified) => external.prepare(context, verified as Verified<Payload>), submitPrepared: external.submit }
		: { submit: submit! };
	return {
		...rest,
		...filing,
		prepareSubmission: draft.prepare,
		verifyDraft: draft.verify,
		...(preview ? { buildReportPreview: preview } : {}),
		...(inbound ? { inboundMail: inboundMailOf(inbound) } : {}),
	};
}

function inboundMailOf({ confirmationIds, ...mail }: NonNullable<Parameters<typeof defineProvider>[0]["inbound"]>): ProviderInboundMail {
	return { ...mail, ...(confirmationIds === null ? {} : { confirmationIds: confirmationIds ?? reportReferencesIn }) };
}
