import { describe, expect, test } from "bun:test";

import { detectLanguage } from "./language";

// The three languages the "Meta Protect" kit spoke to our captures.
const GERMAN = "Willkommen bei Meta Protect. Da die Zugänglichkeit Ihrer Seite eingeschränkt ist, bitten wir Sie, für dieses Konto höhere Sicherheitsanforderungen anzuwenden. Wir haben dieses Sicherheitsprogramm erstellt, um Ihre Seiten zu entsperren. Wir haben erweiterte Schutzmaßnahmen aktiviert, um die Blockierung Ihrer Seite aufzuheben.";
const DANISH = "Velkommen til Meta Protect. Din sides tilgængelighed er begrænset, så vi beder om, at der stilles højere sikkerhedskrav til den pågældende konto. Vi har oprettet dette sikkerhedsprogram for at låse dine sider op. Vi har aktiveret avanceret beskyttelse for at fjerne blokeringen af din side. Fortsætte";
const ENGLISH = "Welcome to Meta Protect. Your page's accessibility is limited, so we ask that higher security requirements be applied to that account. We created this security program to unlock your Pages. We've enabled advanced protections to unblock your Page.";

describe("page language", () => {
	test("tells the kit's languages apart", () => {
		expect(detectLanguage(GERMAN)).toBe("de");
		expect(detectLanguage(DANISH)).toBe("da");
		expect(detectLanguage(ENGLISH)).toBe("en");
	});

	test("tells Norwegian from Danish by the words only one of them uses", () => {
		expect(detectLanguage("Velkommen til Meta Protect. Tilgangen til siden din er blitt begrenset, så vi ber om at det stilles høyere krav til kontoen. Vi har opprettet dette programmet for å låse opp sidene dine. Vennligst fortsette, det er viktig at du gjør det nå og ikke venter.")).toBe("no");
	});

	test("names a language by its script", () => {
		expect(detectLanguage("ログインしてください。お客様のアカウントは一時的にロックされています。本人確認のため、以下の情報を入力してください。")).toBe("ja");
		expect(detectLanguage("Ваш аккаунт временно заблокирован. Пожалуйста, подтвердите свою личность, чтобы восстановить доступ к аккаунту.")).toBe("ru");
	});

	test("gives no language for too little text, or text without telling words", () => {
		expect(detectLanguage("Login")).toBeUndefined();
		expect(detectLanguage("PayPal Login Email Password Submit Continue Sign Up Help Contact Privacy Legal")).toBeUndefined();
	});
});
