// Compatibility boundary for existing application imports. RFC parsing and
// abuse-route selection, configuration, message ingestion, and listener
// lifecycle are implemented under `./imap/`.
export * from "./imap/index";
