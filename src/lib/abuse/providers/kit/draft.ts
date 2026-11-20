import type { AbuseTargetType } from "../../schema";
import { abuseEmailCaseUrl, hostingAddressLine } from "../../mail/draft";
import { routeContext } from "../../worker/shared";
import { reportReference } from "./report_reference";
import type { ProviderSubmissionContext, ProviderSubmissionDefinition, ProviderSubmissionPreparation } from "../submission_contracts";
import { routeIsOurs } from "./pin";
import { stableJson } from "../../../util/hash";

export type RouteData = Awaited<ReturnType<typeof routeContext>>;
/** What `verify` proved: the stored draft, and the live route and report it still matches. */
export type Verified<Payload> = { payload: Payload; data: RouteData };
/** The `verify` result of a draft built by `createDraft`. */
export type VerifiedOf<Draft extends { verify: (...args: never[]) => Promise<unknown> }> = Awaited<ReturnType<Draft["verify"]>>;
export type RouteDeps = { loadRouteContext?: typeof routeContext };

/** The inputs every web-form provider's builder takes from a route and its report. */
export type ReportInput = {
	target: string;
	observedUrls: readonly string[];
	description: string;
	allegationCategory?: string;
	legalBrandUrl?: string | null;
	/** `reportReference(report.id, route.id)`: our reference, which the provider's mail may quote. */
	trackingId: string;
	caseUrl?: string;
	/** `hostingAddressLine` of the route, when the target resolved to a hoster's address. */
	hostingLine?: string;
};

export function reportInputOf({ route, report, target }: RouteData): ReportInput {
	const hostingLine = hostingAddressLine(route);
	const caseUrl = abuseEmailCaseUrl(report.submissionId);
	return {
		target: target.normalizedTarget,
		observedUrls: target.observedUrls,
		description: report.description,
		allegationCategory: report.allegationCategory,
		legalBrandUrl: report.legalBrandUrl,
		trackingId: reportReference(report.id, route.id),
		...(caseUrl ? { caseUrl } : {}),
		...(hostingLine ? { hostingLine } : {}),
	};
}

const insufficient = (reason: string) => ({ outcome: "insufficient_evidence", reason }) as const;

export type DraftSpec<Payload, Input, Deps extends RouteDeps> = {
	definition: ProviderSubmissionDefinition;
	/** The provider's name in error messages; defaults to the definition's display name. */
	label?: string;
	/** Prefix of the refusal reasons: `<prefix>_provider_definition_pin_mismatch` and `<prefix>_report_payload_invalid`. */
	reasonPrefix: string;
	targetTypes: readonly AbuseTargetType[];
	/** Reason for any other target type, verbatim: tests and the case page read it. */
	targetReason: string;
	/** The stored draft as a reader returns it: only the exact shape the builder writes, for the pinned definition. */
	read: (value: unknown) => Payload | undefined;
	/** Builder input from the live route. While verifying, `stored` carries what must not be reselected (its screenshot, its URLs). */
	input: (data: RouteData, stored: Payload | undefined, dependencies: Deps) => Input | Promise<Input>;
	/** A provider-specific gate before building: the refusal reason, or undefined. */
	admit?: (data: RouteData, input: Input) => string | undefined;
	build: (input: Input) => Payload | undefined;
	/** The target the stored draft names, compared with the route's. */
	targetOf: (payload: Payload) => string;
};

/**
 * The pre-marker half of a direct provider: `prepare` checks the route and
 * builds the durable draft; `verify` re-reads that draft before anything
 * crosses the provider boundary and proves it is still exactly what the
 * builder produces from the current route and report. The executor runs
 * `verify` before the marker; after it `stored` is all a submit may read.
 */
export function createDraft<Payload, Input, Deps extends RouteDeps = RouteDeps>(spec: DraftSpec<Payload, Input, Deps>) {
	const displayName = spec.label ?? spec.definition.displayName;
	const loadRoute = (context: ProviderSubmissionContext, dependencies: Deps) => (dependencies.loadRouteContext ?? routeContext)(context.routeId);

	async function prepare(context: ProviderSubmissionContext, dependencies = {} as Deps): Promise<ProviderSubmissionPreparation> {
		const data = await loadRoute(context, dependencies);
		if (!routeIsOurs(spec.definition, data.route)) return insufficient(`${spec.reasonPrefix}_provider_definition_pin_mismatch`);
		if (!spec.targetTypes.includes(data.target.targetType)) return insufficient(spec.targetReason);
		const input = await spec.input(data, undefined, dependencies);
		const refusal = spec.admit?.(data, input);
		if (refusal) return insufficient(refusal);
		const payload = spec.build(input);
		return payload ? { outcome: "ready", payload: payload as Record<string, unknown> } : insufficient(`${spec.reasonPrefix}_report_payload_invalid`);
	}

	function stored(context: ProviderSubmissionContext): Payload {
		const payload = spec.read(context.payload);
		if (!payload) throw new Error(`The persisted ${displayName} submission payload is malformed.`);
		return payload;
	}

	async function verify(context: ProviderSubmissionContext, dependencies = {} as Deps): Promise<Verified<Payload>> {
		const payload = stored(context);
		const data = await loadRoute(context, dependencies);
		if (!routeIsOurs(spec.definition, data.route) || data.target.normalizedTarget !== spec.targetOf(payload)) {
			throw new Error(`The persisted ${displayName} payload no longer matches its route.`);
		}
		const expected = spec.build(await spec.input(data, payload, dependencies));
		if (!expected || stableJson(expected) !== stableJson(payload)) throw new Error(`The persisted ${displayName} payload no longer matches the report.`);
		return { payload, data };
	}

	return { prepare, verify, stored };
}
