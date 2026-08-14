/**
 * GNAME worker compatibility barrel.
 *
 * The implementation is split by concern so callers keep the historical
 * import path while portal execution, durable payload handling, and mailbox
 * delivery remain independently readable.
 */
export { maintainUnknownGnameLocks, gnameCodeLockKey, gnameCodeLockOwner } from "./gname/mailbox";
export { runGnamePortal } from "./gname/portal";
export { sendTotpCode } from "./gname/totp";
