
import { extractPasteCommands, type PasteCommand } from "../malware/paste_commands";
import { sha256Hex } from "../util/hash";

/**
 * The command a page makes visitors paste, as an operator's signature. An
 * operator rotates the payload host and path and the app name in the decoy
 * from site to site, but keeps the command's shape: the flags, the encoding,
 * the interpreter, the decoy. The template keeps that shape and blanks out
 * what rotates.
 */
const URL_PLACEHOLDER = "<url>";
const BLOB_PLACEHOLDER = "<base64>";
const TEXT_PLACEHOLDER = "<text>";

/** A quoted URL may hold what ends an unquoted one (`;`, `)`). */
const URL = /(["'])https?:\/\/[^\s'"`]*\1|https?:\/\/[^\s'"`<>|;)\\]+/gi;
const BLOB = /[A-Za-z0-9+/]{24,}={0,2}/g;
const PRINTED = /(\b(?:echo|write-host|write-output)\s+)(["'])(.*?)\2/gi;

function templateOf(layer: string): string {
	return layer
		.replace(URL, (match) => (/^["']/.test(match) ? `${match[0]}${URL_PLACEHOLDER}${match[0]}` : URL_PLACEHOLDER))
		.replace(BLOB, BLOB_PLACEHOLDER)
		// What the command prints to the visitor names the decoy app; its wording is not the operator's.
		.replace(PRINTED, (whole, head: string, quote: string, content: string) => (content === BLOB_PLACEHOLDER || content === URL_PLACEHOLDER ? whole : `${head}${quote}${TEXT_PLACEHOLDER}${quote}`))
		.replace(/\s+/g, " ")
		.trim();
}

export type DeliveryCommand = {
	/** SHA-256 of the template. */
	value: string;
	/** Every layer with URLs, encoded blobs and printed text blanked out, one per line. */
	template: string;
	shown: string;
	interpreters: string[];
	/** Whether the command is specific enough that sharing it ties two sites to one operator. */
	links: boolean;
};

/**
 * A one-liner such as `curl -fsSL <url> | bash` is on thousands of unrelated
 * sites. An encoded layer, a decoy, or several statements make the command
 * the operator's own.
 */
export function deliveryCommand(command: PasteCommand): DeliveryCommand {
	const layers = command.layers.map((layer) => templateOf(layer.text));
	const template = layers.join("\n");
	return {
		value: sha256Hex(template),
		template,
		shown: command.shown,
		interpreters: command.interpreters,
		links: layers.length > 1 || command.decoys.length > 0 || layers.some((layer) => /;|&&/.test(layer)),
	};
}

/** The delivery commands of a page's visitor text. */
export function deliveryCommandsOf(pageText: string): DeliveryCommand[] {
	return extractPasteCommands(pageText).map(deliveryCommand);
}
