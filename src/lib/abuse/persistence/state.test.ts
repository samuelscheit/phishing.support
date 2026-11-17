import { describe, expect, test } from "bun:test";

import { aggregateReportStatus, IMMUTABLE_ROUTE_STATUSES } from "./state";

describe("report status with drafted mails", () => {
	test("a draft waiting for approval needs the operator until something is delivered", () => {
		expect(aggregateReportStatus(["awaiting_approval"])).toBe("needs_human");
		expect(aggregateReportStatus(["awaiting_approval", "discarded"])).toBe("needs_human");
	});

	test("a delivered referral is not partial because a later draft waits or was discarded", () => {
		expect(aggregateReportStatus(["awaiting_provider_reply", "awaiting_approval"])).toBe("waiting_provider");
		expect(aggregateReportStatus(["acknowledged", "discarded", "awaiting_approval"])).toBe("submitted");
		expect(aggregateReportStatus(["acknowledged", "provider_rejected"])).toBe("partially_submitted");
	});

	test("only discarded drafts leave no route; approved ones are in progress", () => {
		expect(aggregateReportStatus(["discarded"])).toBe("no_route");
		expect(aggregateReportStatus(["verified", "awaiting_approval"])).toBe("verifying");
	});

	test("a discarded draft is final; a waiting one is not", () => {
		expect(IMMUTABLE_ROUTE_STATUSES.has("discarded")).toBe(true);
		expect(IMMUTABLE_ROUTE_STATUSES.has("awaiting_approval")).toBe(false);
	});
});
