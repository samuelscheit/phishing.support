import { describe, expect, test } from "bun:test";

import type { Dossier, DossierSite } from "../referral/dossier";
import { campaignVisitorKinds, fieldKinds } from "./kinds";

describe("what a page field asks for", () => {
	test.each([
		// Production labels.
		["Email or phone", ["email", "phone"]],
		["Enter code", ["code"]],
		["Mật khẩu", ["password"]],
		// English, German, French, Spanish, Italian, Portuguese, Vietnamese.
		["Password", ["password"]],
		["input[type=password]", ["password"]],
		["Passwort", ["password"]],
		["Kennwort", ["password"]],
		["Mot de passe", ["password"]],
		["Contraseña", ["password"]],
		["Senha", ["password"]],
		["E-Mail-Adresse", ["email"]],
		["Email address", ["email"]],
		["Adresse e-mail", ["email"]],
		["Correo electrónico", ["email"]],
		["Dirección de correo electrónico", ["email"]],
		["Indirizzo email", ["email"]],
		["Endereço de e-mail", ["email"]],
		["Địa chỉ email", ["email"]],
		["input[type=email]", ["email"]],
		["Bestätigungscode", ["code"]],
		["Code de vérification", ["code"]],
		["Código de verificación", ["code"]],
		["Codice di verifica", ["code"]],
		["Mã xác minh", ["code"]],
		["OTP", ["code"]],
		["TAN", ["code"]],
		["One-time password", ["code"]],
		["Telefonnummer", ["phone"]],
		["Mobilnummer", ["phone"]],
		["Numéro de téléphone", ["phone"]],
		["Teléfono móvil", ["phone"]],
		["Número de celular", ["phone"]],
		["Số điện thoại", ["phone"]],
		["input[type=tel]", ["phone"]],
		["Country code", ["phone"]],
		["Card number", ["card"]],
		["Kartennummer", ["card"]],
		["Numéro de carte", ["card"]],
		["Número de tarjeta", ["card"]],
		["Numero carta", ["card"]],
		["CVV", ["card"]],
		["MM/YY", ["card"]],
		["Ablaufdatum", ["card"]],
		["IBAN", ["payment"]],
		["Full name", ["personal"]],
		["Vorname", ["personal"]],
		["Prénom", ["personal"]],
		["Apellidos", ["personal"]],
		["Họ và tên", ["personal"]],
		["Date of birth", ["personal"]],
		["Geburtsdatum", ["personal"]],
		["Street address", ["personal"]],
		["Postal code", ["personal"]],
		["Código postal", ["personal"]],
		["Codice fiscale", ["personal"]],
		["CPF", ["personal"]],
		// Words that only look like a kind.
		["Username", []],
		["Nom d’utilisateur", []],
		["Benutzername", []],
		["Search", []],
		["Amount", []],
		["Submit", []],
	] as const)("%s", (label, kinds) => {
		expect(fieldKinds(label)).toEqual([...kinds]);
	});
});

const site = (verdict?: Partial<NonNullable<DossierSite["verdict"]>>): DossierSite => ({
	...({} as DossierSite),
	...(verdict ? { verdict: { finding: "phishing", fields: [], ...verdict } } : {}),
});

const dossier = (parts: Partial<Pick<Dossier, "requestedFields" | "sites" | "indicators">>): Pick<Dossier, "requestedFields" | "sites" | "indicators"> => ({
	requestedFields: [],
	sites: [],
	indicators: [],
	...parts,
});

describe("what a campaign's visitors may have typed", () => {
	test("joins the values our visits saw sent, the pages' field labels in any language and the guidance, in the order the pages ask", () => {
		expect(campaignVisitorKinds(dossier({
			requestedFields: ["oneTimeCode", "password"],
			sites: [site({ fields: ["Mật khẩu", "Email or phone"] }), site({ fields: ["Kartennummer", "Geburtsdatum"] }), site()],
		}), ["email"])).toEqual(["email", "password", "code", "phone", "card", "personal"]);
		expect(campaignVisitorKinds(dossier({ requestedFields: ["cardNumber", "email", "unknown"] }))).toEqual(["email", "card"]);
	});

	test("a page that asks for a payment, by its finding or by an account it names, adds the payment", () => {
		expect(campaignVisitorKinds(dossier({ sites: [site({ basis: "payment_fraud" })] }))).toEqual(["payment"]);
		expect(campaignVisitorKinds(dossier({ requestedFields: ["email"], indicators: [{ kind: "payment_receiver", value: "iban:DE89", links: true, evidence: {}, sites: [] }] }))).toEqual(["email", "payment"]);
		// An account that links nothing is no proof the pages ask for it.
		expect(campaignVisitorKinds(dossier({ requestedFields: ["email"], indicators: [{ kind: "payment_receiver", value: "iban:DE89", links: false, evidence: {}, sites: [] }] }))).toEqual(["email"]);
	});

	test("a sign-in page whose fields say nothing asks for an email address and a password", () => {
		expect(campaignVisitorKinds(dossier({ sites: [site({ basis: "credential_theft", fields: ["input[type=text]", "Weiter"] })] }))).toEqual(["email", "password"]);
		expect(campaignVisitorKinds(dossier({}))).toEqual(["email", "password"]);
	});
});
