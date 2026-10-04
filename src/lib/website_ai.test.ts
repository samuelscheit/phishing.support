import { expect, test } from "bun:test";

import {
	buildWebsiteAnalysisInput,
	buildWebsiteClassificationInput,
	reportableWebsiteHop,
	validateWebsiteSiteClassification,
	websiteSiteAssessments,
} from "./website_ai";
import type { WebsiteNavigationHop } from "./submissions/website_types";

const shareGoogleHop: WebsiteNavigationHop = {
	index: 0,
	url: "https://share.google/ZAq2FghpGquJH6ShL",
	hostname: "share.google",
	status: 302,
	redirectTo: "https://www.google.com/share.google?q=ZAq2FghpGquJH6ShL",
	contentType: "text/html; charset=UTF-8",
	contentCaptured: false,
};

const finalTrollHop: WebsiteNavigationHop = {
	index: 1,
	url: "https://fuckyou.gay/",
	hostname: "fuckyou.gay",
	status: 200,
	contentType: "text/html; charset=UTF-8",
	contentCaptured: true,
};

const redirectArchive = {
	requestedUrl: shareGoogleHop.url,
	url: finalTrollHop.url,
	hostname: finalTrollHop.hostname,
	navigationHops: [shareGoogleHop, finalTrollHop],
	text: Buffer.from("You got trolled. Fuck you!", "utf-8"),
	html: Buffer.from("<html><body>You got trolled. Fuck you!</body></html>", "utf-8"),
};

test("detailed analysis binds the page content to the exact captured URL", () => {
	const input = buildWebsiteAnalysisInput(redirectArchive);
	const system = input[0].content as string;
	const text = (input[1].content as Array<{ text: string }>)[0]!.text;

	expect(system).toContain("Never attribute one hop's content");
	expect(text).toContain(`Only this final URL's page content was captured: ${finalTrollHop.url}`);
	expect(text).toContain(shareGoogleHop.url);
	expect(text).toContain("redirect response does not include the redirected site's page content");
	expect(text).toContain("a prank/troll");
	expect(text).toContain("You got trolled");
});

test("classification receives only one exact site's captured evidence", () => {
	const input = buildWebsiteClassificationInput(finalTrollHop, redirectArchive);
	const system = input[0].content as string;
	const userContent = input[1].content as Array<{ type: string; text?: string }>;

	expect(system).toContain("A prank, troll page");
	expect(userContent[0]?.text).toContain(finalTrollHop.url);
	expect(userContent[0]?.text).toContain("You got trolled");
	expect(userContent[0]?.text).not.toContain(shareGoogleHop.url);
	expect(() => buildWebsiteClassificationInput(shareGoogleHop, redirectArchive)).toThrow("exact navigation hop");
});

test("redirect-only hops cannot inherit the captured destination's phishing finding", () => {
	expect(websiteSiteAssessments([shareGoogleHop, finalTrollHop], 1, { finding: "prank_or_troll" })).toEqual([
		{ hopIndex: 0, finding: "insufficient_evidence" },
		{ hopIndex: 1, finding: "prank_or_troll" },
	]);
	expect(validateWebsiteSiteClassification({ finding: "prank_or_troll", phishingBasis: "none", evidenceQuote: "" }, "You got trolled. Fuck you!")).toEqual({ finding: "prank_or_troll" });
	expect(validateWebsiteSiteClassification({ finding: "phishing", phishingBasis: "credential_theft", evidenceQuote: "unrelated fabricated evidence" }, "You got trolled. Fuck you!")).toEqual({ finding: "insufficient_evidence" });
	expect(validateWebsiteSiteClassification({ finding: "phishing", phishingBasis: "none", evidenceQuote: "You got trolled. Fuck you!" }, "You got trolled. Fuck you!")).toEqual({ finding: "insufficient_evidence" });
	expect(() => validateWebsiteSiteClassification({ finding: "suspicious", phishingBasis: "none", evidenceQuote: "" }, "page text")).toThrow("invalid finding");
});

test("a captured credential-collection page remains eligible for an exact-site phishing finding", () => {
	const hop: WebsiteNavigationHop = {
		index: 0,
		url: "https://idcredian.com/TylerBaker7651",
		hostname: "idcredian.com",
		status: 200,
		contentType: "text/html",
		contentCaptured: true,
	};
	const archive = {
		requestedUrl: hop.url,
		url: hop.url,
		hostname: hop.hostname,
		navigationHops: [hop],
		text: Buffer.from("Welcome | USPS\\nConfirm your delivery address and pay a redelivery fee.", "utf-8"),
		html: Buffer.from('<title>Welcome | USPS</title><form><input name="cardNumber"></form>', "utf-8"),
		screenshotPng: Buffer.from("fake png bytes", "utf-8"),
	};
	const content = buildWebsiteClassificationInput(hop, archive)[1].content as Array<{ type: string }>;

	expect(content[0]?.type).toBe("input_text");
	expect(content[1]?.type).toBe("input_image");
	const classification = validateWebsiteSiteClassification({
		finding: "phishing",
		phishingBasis: "credential_theft",
		evidenceQuote: "Confirm your delivery address and pay a redelivery fee.",
	}, archive.text.toString());
	expect(classification).toEqual({ finding: "phishing", evidenceQuote: "Confirm your delivery address and pay a redelivery fee." });
	expect(websiteSiteAssessments([hop], 0, classification)).toEqual([{
		hopIndex: 0,
		finding: "phishing",
		evidenceQuote: "Confirm your delivery address and pay a redelivery fee.",
	}]);
});


test("the report gate rejects troll pages and never lets destination content trigger a source-hop report", () => {
	const trollAssessments = websiteSiteAssessments([shareGoogleHop, finalTrollHop], 1, { finding: "prank_or_troll" });
	expect(reportableWebsiteHop([shareGoogleHop, finalTrollHop], trollAssessments, redirectArchive)).toBeUndefined();

	const capturedPhishingAssessments = websiteSiteAssessments([shareGoogleHop, finalTrollHop], 1, {
		finding: "phishing",
		evidenceQuote: "This exact quote supports the captured site's harmful action.",
	});
	expect(reportableWebsiteHop([shareGoogleHop, finalTrollHop], capturedPhishingAssessments, { ...redirectArchive, text: Buffer.from("This exact quote supports the captured site's harmful action.") })).toEqual(finalTrollHop);
	// Even a malformed assessment cannot send the terminal page's evidence to the shortener.
	expect(reportableWebsiteHop(
		[shareGoogleHop, finalTrollHop],
		[{ hopIndex: shareGoogleHop.index, finding: "phishing", evidenceQuote: "redirect response only" }],
		redirectArchive,
	)).toBeUndefined();
});
