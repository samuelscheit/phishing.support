import type { PortalProvider } from "../contracts";

import { deliverGnameVerificationCode, fenceGnameRetryExhaustion } from "./code_delivery";
import { GNAME_PROVIDER } from "./definition";
import { findGnameInboundRoute, onGnameInboundMessageStored } from "./inbound";
import { maintainGnameMailboxReservations } from "./mailbox";
import { runGnamePortal } from "./portal";
import { reconcileGnamePortalRun } from "./reconcile";
import { createGnameRegistrarRoute } from "./route";
import { verifyGnameProviderRoute } from "./verify_route";

/** The one executable owner of GNAME's route, portal, mailbox, and form policy. */
export const gnameProvider: PortalProvider = {
	definition: GNAME_PROVIDER,
	createRegistrarRoute: createGnameRegistrarRoute,
	verifyRoute: verifyGnameProviderRoute,
	runPortal: runGnamePortal,
	reconcileRun: reconcileGnamePortalRun,
	deliverVerificationCode: deliverGnameVerificationCode,
	findInboundRoute: findGnameInboundRoute,
	onInboundMessageStored: onGnameInboundMessageStored,
	maintain: maintainGnameMailboxReservations,
	onRetryExhausted: fenceGnameRetryExhaustion,
};
