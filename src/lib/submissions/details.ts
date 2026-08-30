import {
	AnalysisRunsEntity,
	ArtifactsEntity,
	ProviderReportsEntity,
	ReportMessagesEntity,
	ReportThreadsEntity,
	SubmissionsEntity,
} from "@/lib/db/entities";
import type { AnalysisRun, Artifact, ProviderReport, ReportMessage, ReportThread, Submission } from "@/lib/db/schema";
import { getStandaloneAbuseDetailsForSubmission } from "./abuse_details";
export type { SubmissionAbuseMailReport, SubmissionAbuseProviderReport } from "./abuse_details";
import type { SubmissionAbuseMailReport, SubmissionAbuseProviderReport } from "./abuse_details";

export type SubmissionArtifact = Omit<Artifact, "blob" | "submissionId">;

/** Public correspondence message DTO. Internal error/provider fields stay server-side. */
export type SubmissionReportMessage = Pick<
	ReportMessage,
	| "id"
	| "direction"
	| "kind"
	| "status"
	| "from"
	| "to"
	| "cc"
	| "subject"
	| "textBody"
	| "htmlBody"
	| "messageId"
	| "inReplyTo"
	| "references"
	| "occurredAt"
	| "sentAt"
	| "rawArtifactId"
	| "attachmentArtifactIds"
>;

/** Public correspondence thread DTO; replyToken is intentionally never exposed. */
export type SubmissionReportThread = Pick<
	ReportThread,
	"id" | "to" | "subject" | "replyAddress" | "status" | "createdAt" | "updatedAt"
> & {
	messages: SubmissionReportMessage[];
};

/** Public provider-report DTO. Provider implementation context stays server-side. */
export type SubmissionProviderReport = Pick<
	ProviderReport,
	| "id"
	| "channel"
	| "to"
	| "subject"
	| "body"
	| "status"
	| "sentAt"
	| "providerMessageId"
	| "providerSubmissionUrl"
	| "attachmentsArtifactIds"
	| "legacy"
	| "createdAt"
>;

export type SubmissionDetail = Submission & {
	analysisRuns: AnalysisRun[];
	reportThreads: SubmissionReportThread[];
	providerReports: SubmissionProviderReport[];
	/** Outbound emails persisted by the standalone abuse-reporting worker. */
	abuseMailReports: SubmissionAbuseMailReport[];
	/** Direct provider submissions persisted by the standalone abuse worker. */
	abuseProviderReports: SubmissionAbuseProviderReport[];
	artifacts: SubmissionArtifact[];
};

export async function getSubmissionDetails(id: string): Promise<SubmissionDetail | undefined> {
	let submissionId: bigint;
	try {
		submissionId = BigInt(id);
	} catch {
		return undefined;
	}

	const submission = await SubmissionsEntity.get(submissionId);
	if (!submission) return undefined;

	const [analysisRuns, reportThreads, providerReports, standaloneAbuse, artifacts] = await Promise.all([
		AnalysisRunsEntity.listForSubmission(submissionId),
		ReportThreadsEntity.listForSubmission(submissionId),
		ProviderReportsEntity.listForSubmission(submissionId),
		getStandaloneAbuseDetailsForSubmission(submissionId),
		ArtifactsEntity.listForSubmission(submissionId),
	]);
	const messages = await ReportMessagesEntity.listForThreads(reportThreads.map((thread) => thread.id));
	const messagesByThread = new Map<bigint, ReportMessage[]>();
	for (const message of messages) {
		const threadMessages = messagesByThread.get(message.threadId) ?? [];
		threadMessages.push(message);
		messagesByThread.set(message.threadId, threadMessages);
	}

	return {
		...submission,
		analysisRuns,
		reportThreads: reportThreads.map((thread) => ({
			id: thread.id,
			to: thread.to,
			subject: thread.subject,
			replyAddress: thread.replyAddress,
			status: thread.status,
			createdAt: thread.createdAt,
			updatedAt: thread.updatedAt,
			messages: (messagesByThread.get(thread.id) ?? []).map((message) => ({
				id: message.id,
				direction: message.direction,
				kind: message.kind,
				status: message.status,
				from: message.from,
				to: message.to,
				cc: message.cc,
				subject: message.subject,
				textBody: message.textBody,
						htmlBody: message.htmlBody,
						messageId: message.messageId,
						inReplyTo: message.inReplyTo,
						references: message.references,
						occurredAt: message.occurredAt,
				sentAt: message.sentAt,
				rawArtifactId: message.rawArtifactId,
				attachmentArtifactIds: message.attachmentArtifactIds,
			})),
		})),
		providerReports: providerReports.map((report) => ({
			id: report.id,
			channel: report.channel,
			to: report.to,
			subject: report.subject,
			body: report.body,
			status: report.status,
			sentAt: report.sentAt,
			providerMessageId: report.providerMessageId,
			providerSubmissionUrl: report.providerSubmissionUrl,
			attachmentsArtifactIds: report.attachmentsArtifactIds,
			legacy: report.legacy,
			createdAt: report.createdAt,
		})),
		abuseMailReports: standaloneAbuse.mailReports,
		abuseProviderReports: standaloneAbuse.providerReports,
		artifacts,
	};
}
