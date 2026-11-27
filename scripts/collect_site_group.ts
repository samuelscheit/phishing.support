/**
 * Collect the hosts of one site group (a registrable domain) into the group's
 * report, as the visit queue does once a host of the group is reported
 * (`collectSiteGroup`, website/visit_queue/collect.ts): every case of the
 * group that is not reported itself and not being visited right now joins the
 * report (`abuse_report_cases`), becomes a member of its campaign, drops its
 * waiting visit and scheduled retries, and gets one plain-fetch probe.
 *
 * `--include-settled` also collects the group's failed and invalid cases (a
 * group that was visited host by host before the queue existed, such as the
 * slon10.to flood of 2026-11-26). Without it only waiting hosts are collected.
 * `--dry-run` lists what would be collected and changes nothing.
 *
 * Run inside the app container, after the deploy that added site groups:
 *   docker exec -w /app <container> bun scripts/collect_site_group.ts slon10.to --include-settled [--dry-run]
 */
import { siteGroupReport } from "../src/lib/abuse/persistence/reports";
import { SubmissionsEntity } from "../src/lib/db/entities/submissions";
import { collectSiteGroup } from "../src/lib/website/visit_queue/collect";
import { backfillSiteGroups } from "../src/lib/website/visit_queue/site_group";

const args = process.argv.slice(2);
const group = args.find((arg) => !arg.startsWith("--"));
if (!group) {
	console.error("Usage: bun scripts/collect_site_group.ts <site group, e.g. slon10.to> [--include-settled] [--dry-run]");
	process.exit(2);
}
const includeSettled = args.includes("--include-settled");
const dryRun = args.includes("--dry-run");

await backfillSiteGroups();
const report = await siteGroupReport(group);
const cases = await SubmissionsEntity.listSiteGroupCases(group);
const byStatus = Object.groupBy(cases, (submission) => submission.status);
console.log(`${group}: ${cases.length} cases (${Object.entries(byStatus).map(([status, rows]) => `${rows!.length} ${status}`).join(", ")}).`);
if (!report) {
	console.error(`${group} has no open or taken-down report to collect into; nothing done.`);
	process.exit(1);
}
console.log(`Collecting into report ${report.reportId} of case ${report.submissionId}${report.takenDown ? " (taken down)" : ""}.`);
if (dryRun) process.exit(0);
const collected = await collectSiteGroup(group, { includeSettled });
console.log(`Collected ${collected} cases.`);
