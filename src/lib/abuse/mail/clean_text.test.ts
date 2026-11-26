import { describe, expect, test } from "bun:test";

import { cleanMailText, leadSentence } from "./clean_text";
import { TRYLEVO_MAIL } from "./trylevo_mail.fixtures";

describe("cleanMailText", () => {
	test("Netcraft's notification loses its leaked style sheet, link list and link markers, and keeps every sentence it says", () => {
		const { main, quoted } = cleanMailText(TRYLEVO_MAIL.netcraftNoThreat);
		expect(main).toContain("has been automatically analysed, and no threats were found.");
		expect(main).toContain("If you think this classification is incorrect, you can report an issue on the submission's page.");
		expect(main).not.toMatch(/@media|!important|\{|\}|table\[class=body\]|&nbsp;/);
		expect(main).not.toContain("References");
		expect(main).not.toContain("unsubscribe?email=");
		expect(main).not.toMatch(/\[\d+\]/);
		expect(main.endsWith("click here to update your user preferences.")).toBeTrue();
		expect(quoted).toBeNull();
	});

	test("Cloudflare's response keeps what it says and folds our report it quotes back", () => {
		const { main, quoted } = cleanMailText(TRYLEVO_MAIL.cloudflareRestricted);
		expect(main.startsWith("Hello,\n\nCloudflare received your Phishing report regarding: trylevo[.]app.")).toBeTrue();
		expect(main).toContain("Sollutium-NL - SOLLUTIUM EU Sp z.o.o., PL\nabuse-ams@v-sys.org");
		expect(main.endsWith("To respond to this issue, please reply to abusereply@cloudflare.com.")).toBeTrue();
		expect(quoted?.startsWith("Below is the report we received:\n\nReport ID: 983629f3ca31bae5")).toBeTrue();
		expect(main).not.toContain("Report ID:");
	});

	test("HTML is turned into text, entities decoded, tags and styles gone", () => {
		const html = "<html><head><style>p { color: red; }</style></head><body><p>Dear reporter,</p><p>We have suspended the domain &amp; its hosting.<br>Regards</p><script>alert(1)</script></body></html>";
		expect(cleanMailText(html)).toEqual({ main: "Dear reporter,\n\nWe have suspended the domain & its hosting.\nRegards", quoted: null });
	});

	test("a bare declaration block cuts only from its selector, after the last sentence", () => {
		expect(cleanMailText("Your ticket was closed. Thanks! .btn a { width: 100% !important; } Thanks!").main).toBe("Your ticket was closed. Thanks!");
	});

	test("a reply's quoted original and a forwarded message are folded; a quote marker at the very start is not a split", () => {
		expect(cleanMailText("We took the site down.\n\nOn Wed, 26 Nov 2026 at 19:05, Phishing Support <support@phishing.support> wrote:\n> Hello Sollutium").quoted).toStartWith("On Wed, 26 Nov 2026");
		expect(cleanMailText("Thanks.\n-----Original Message-----\nFrom: us").quoted).toBe("-----Original Message-----\nFrom: us");
		expect(cleanMailText("> only a quote\nand more")).toEqual({ main: "> only a quote\nand more", quoted: null });
	});

	test("blank runs collapse to one empty line and lines are trimmed", () => {
		expect(cleanMailText("  a  \r\n\r\n\r\n\r\n  b\t\tc ").main).toBe("a\n\nb c");
	});
});

describe("leadSentence", () => {
	test("skips the greeting and takes the first sentence", () => {
		expect(leadSentence("Hello,\n\nCloudflare received your Phishing report regarding: hostsync[.]pro.\n\nThe reported content is no longer visible.")).toBe("Cloudflare received your Phishing report regarding: hostsync[.]pro.");
		expect(leadSentence("Dear Abuse Team,\nWe received your report. More.")).toBe("We received your report.");
	});

	test("a long sentence is cut at a word with an ellipsis; nothing to say is undefined", () => {
		expect(leadSentence(`${"word ".repeat(80)}end.`, 50)).toMatch(/^(word ){8}word…$/);
		expect(leadSentence("Hello,")).toBeUndefined();
		expect(leadSentence("")).toBeUndefined();
	});
});
