import { abuseEmailCaseUrl } from "../../mail/draft";
import { createDraft, type VerifiedOf, type RouteDeps } from "../kit/draft";
import { snippet } from "../../../util/text";
import { preparedState, withPreflight } from "../kit/session";
import { mailedCodeReader, type MailedCodeReader } from "../kit/mailed_code";
import {
	ProviderSubmissionRejectedError,
	type ProviderSubmissionContext,
	type ProviderSubmissionPreflight,
	type ProviderSubmissionSuccess,
} from "../submission_contracts";
import { DISCORD_DSA_PROVIDER } from "./definition";
import { buildDiscordDsaPayload, discordDsaRefusal, storedDiscordDsaPayload, webhookEvidence } from "./payload";
import { openDiscordDsaSession, type DiscordDsaSession } from "./session";

export type DiscordDsaDependencies = RouteDeps & {
	openSession?: () => Promise<DiscordDsaSession>;
	readCode?: MailedCodeReader;
	now?: () => Date;
	environment?: Readonly<Record<string, string | undefined>>;
};

export const discordDsaDraft = createDraft({
	definition: DISCORD_DSA_PROVIDER,
	reasonPrefix: "discord_dsa",
	targetTypes: ["service_account"],
	targetReason: "discord_dsa_requires_a_webhook_target",
	read: storedDiscordDsaPayload,
	input: ({ report, target, evidenceArtifacts }, _stored, dependencies: DiscordDsaDependencies) => {
		const evidence = webhookEvidence(evidenceArtifacts);
		const environment = dependencies.environment ?? process.env;
		const name = environment.DISCORD_DSA_REPORTER_NAME?.trim();
		const country = environment.DISCORD_DSA_REPORTER_COUNTRY?.trim();
		return {
			evidence,
			caseUrl: abuseEmailCaseUrl(report.submissionId ?? (evidence?.submissionId ? BigInt(evidence.submissionId) : undefined)),
			reporter: name && country ? { name, country } : undefined,
			target: target.normalizedTarget,
		};
	},
	admit: (_data, input) => discordDsaRefusal(input),
	build: buildDiscordDsaPayload,
	targetOf: (payload) => payload.target.normalizedTarget,
});

/**
 * Before the marker: have Discord mail its key, read it, and fill every step
 * up to the summary. Nothing is filed until "Submit Report", so every failure
 * here is a safe retry.
 */
export async function prepareDiscordDsaExternalSubmission(context: ProviderSubmissionContext, { payload }: VerifiedOf<typeof discordDsaDraft>, dependencies: DiscordDsaDependencies = {}): Promise<ProviderSubmissionPreflight> {
	return withPreflight(() => (dependencies.openSession ?? openDiscordDsaSession)(), async (session) => {
		const requestedAt = (dependencies.now ?? (() => new Date()))();
		await session.requestCode(payload.report.reporter.email);
		const code = await (dependencies.readCode ?? mailedCodeReader(DISCORD_DSA_PROVIDER.codeMail))(requestedAt, context.signal);
		await session.fill(code, payload.report);
		return session;
	});
}

/** The one irreversible step: "Submit Report" on the filled summary. */
export async function submitDiscordDsaSubmission(context: ProviderSubmissionContext, preflight: ProviderSubmissionPreflight): Promise<ProviderSubmissionSuccess> {
	const payload = discordDsaDraft.stored(context);
	const session = preparedState<DiscordDsaSession>(preflight, (candidate) => !!candidate.submit, "Discord DSA submission requires the filled form from its preflight.");
	const answer = await session.submit();
	if (!/report submitted/i.test(answer)) throw new ProviderSubmissionRejectedError(`Discord did not confirm the report: ${snippet(answer)}`);
	return {
		confirmationText: `Discord accepted the DSA notice about server ${payload.report.serverId}: "${snippet(answer).slice(0, 200)}"`,
		finalUrl: DISCORD_DSA_PROVIDER.reportUrl,
		submittedTargets: [`discord-server:${payload.report.serverId}`],
	};
}
