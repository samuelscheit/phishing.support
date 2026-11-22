import { readFileSync } from "node:fs";
import path from "node:path";

/** The Message-ID and Reply-To identity of ours that every fixture returns, as 48 hex digits like the real ones. */
export const FIXTURE_MESSAGE_ID = `<abuse-${"5e".repeat(24)}@phishing.support>`;
const FIXTURE_REPLY_ADDRESS = `abuse-${"7a".repeat(24)}@phishing.support`;

/**
 * A stored delivery report (see README.md), returning `ours` instead of the
 * fixture's identities. The local parts keep their length, so quoted-printable
 * lines that split them stay valid.
 */
export function deliveryReportFixture(name: string, ours?: { messageId: string | null; replyAddress: string | null }): Buffer {
	let raw = readFileSync(path.join(import.meta.dir, name), "latin1");
	if (ours?.messageId) raw = raw.replaceAll(localPart(FIXTURE_MESSAGE_ID), localPart(ours.messageId));
	if (ours?.replyAddress) raw = raw.replaceAll(localPart(FIXTURE_REPLY_ADDRESS), localPart(ours.replyAddress));
	return Buffer.from(raw, "latin1");
}

function localPart(address: string): string {
	return address.replace(/^</, "").split("@")[0]!;
}
