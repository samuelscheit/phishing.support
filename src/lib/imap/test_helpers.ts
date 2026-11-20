import { AbuseRepository } from "../abuse/repository";

/** An intake that fails the test when a message that must not start an analysis reaches it. */
export const noIntake = async () => {
	throw new Error("Intake must not run for this message.");
};

/** The mail we received for a report, whatever it was a reply to. */
export async function inboundMail(reportId: bigint) {
	return (await AbuseRepository.listMailForReport(reportId)).filter((message) => message.direction === "inbound");
}
