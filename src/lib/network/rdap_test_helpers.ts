import type { RdapLocator } from "./rdap_bootstrap";

/** The fixture RDAP server of resolver tests. */
export const TEST_RDAP_SERVER = "https://rdap.test/";

/** Every record on the fixture server, the way an authoritative server lays them out. */
export const testRdapLocator: RdapLocator = async (object, value) => `${TEST_RDAP_SERVER}${object}/${value}`;
