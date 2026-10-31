import { serviceIdentity } from "../../../constants";
import { hashStableJson } from "../../security";
import type { ProviderSubmissionDefinition } from "../submission_contracts";

export type NameSiloProviderDefinition = ProviderSubmissionDefinition & {
	reportPageUrl: string;
	tokenUrl: string;
	submissionUrl: string;
	captcha: {
		provider: "death_by_captcha";
		type: 4;
		siteKey: string;
	};
	evidence: {
		acceptedMimeTypes: readonly ["image/jpeg", "image/png", "image/gif", "image/tiff"];
		maximumBytes: number;
	};
	maximumReportLength: number;
	reporter: {
		email: string;
	};
};

/**
 * Code-owned contract for NameSilo's dedicated phishing form. Runtime
 * credentials, CSRF tokens, cookies, and CAPTCHA solutions are deliberately
 * excluded from the route-pinned definition and durable provider payload.
 */
const definitionWithoutHash = {
	key: "namesilo",
	displayName: "NameSilo Phishing Report",
	version: "2026-10-31.1",
	exactMailboxes: ["abuse@namesilo.com", "support@namesilo.com"],
	supplemental: false,
	reportPageUrl: "https://www.namesilo.com/phishing-report",
	tokenUrl: "https://www.namesilo.com/public/api/token",
	submissionUrl: "https://www.namesilo.com/support/v2/api/phishing-report",
	captcha: {
		provider: "death_by_captcha" as const,
		type: 4 as const,
		siteKey: "6Lfe4ecUAAAAAIxF5o-pwBxeh7Mx38GpggsY2gTF",
	},
	evidence: {
		acceptedMimeTypes: ["image/jpeg", "image/png", "image/gif", "image/tiff"] as const,
		maximumBytes: 10 * 1_000_000,
	},
	maximumReportLength: 5_000,
	reporter: {
		email: serviceIdentity.mailbox,
	},
};

export const NAMESILO_PROVIDER: NameSiloProviderDefinition = Object.freeze({
	...definitionWithoutHash,
	contentHash: hashStableJson(definitionWithoutHash),
});
