import { expect, test } from "bun:test";

import { extractWebsiteDataEntryFields } from "./website_fields";

test("lists data-entry controls of script-driven dialogs that have no form element", () => {
	const fields = extractWebsiteDataEntryFields(`<body>
<input type="text" class="search-box" placeholder="Tìm kiếm">
<div class="login-form"><h3>TikTok ID</h3><input type="text" class="login-input" placeholder="Nhập TikTok ID của bạn" id="username"></div>
<div class="payment-popup">
	<input type="radio" name="payment_method" value="phone-card" id="phone-card">
	<div class="input-group"><label class="input-label">Mã thẻ</label><input type="text" class="card-input" id="phone-card-code" placeholder="Nhập mã thẻ" autocomplete="off"></div>
	<div class="input-group"><label class="input-label">Số seri</label><input type="text" class="card-input" id="phone-card-serial" placeholder="Nhập seri thẻ" autocomplete="off"></div>
</div></body>`);

	expect(fields).toEqual([
		{ ref: "f1", control: "input[type=text]", placeholder: "Tìm kiếm" },
		{ ref: "f2", control: "input[type=text]", id: "username", placeholder: "Nhập TikTok ID của bạn" },
		{ ref: "f3", control: "input[type=text]", id: "phone-card-code", autocomplete: "off", label: "Mã thẻ", placeholder: "Nhập mã thẻ" },
		{ ref: "f4", control: "input[type=text]", id: "phone-card-serial", autocomplete: "off", label: "Số seri", placeholder: "Nhập seri thẻ" },
	]);
});

test("skips controls through which a visitor cannot enter data", () => {
	const fields = extractWebsiteDataEntryFields(`<form>
	${["hidden", "submit", "button", "image", "reset", "checkbox", "radio", "range", "color", "search"].map((type) => `<input type="${type}" name="${type}">`).join("")}
	<input name="disabled" disabled><input name="readonly" readonly><textarea name="readonly-notes" readonly></textarea><div contenteditable="false">fixed</div>
	<input type="PASSWORD" name="pass"><input name="untyped"><input type="unknown" name="unknown-type"><input type="file" name="id-document">
	<textarea name="seed-phrase"></textarea><select name="expiry-month"><option>01</option></select><div contenteditable id="editable-code"></div>
</form>`);

	expect(fields.map(({ ref, control, name, id }) => ({ ref, control, name, id }))).toEqual([
		{ ref: "f1", control: "input[type=password]", name: "pass", id: undefined },
		{ ref: "f2", control: "input[type=text]", name: "untyped", id: undefined },
		{ ref: "f3", control: "input[type=unknown]", name: "unknown-type", id: undefined },
		{ ref: "f4", control: "input[type=file]", name: "id-document", id: undefined },
		{ ref: "f5", control: "textarea", name: "seed-phrase", id: undefined },
		{ ref: "f6", control: "select", name: "expiry-month", id: undefined },
		{ ref: "f7", control: "div[contenteditable]", name: undefined, id: "editable-code" },
	]);
});

test("describes each field with its own label text in any language", () => {
	const fields = extractWebsiteDataEntryFields(`
<span id="pin-caption">PIN</span><span id="pin-hint">Bank</span><input name="pin" aria-labelledby="pin-caption  pin-hint">
<input name="otp" aria-label="驗證碼">
<label for="pw">Пароль</label><input id="pw" type="password">
<label>Kartennummer <input name="cc"></label><input name="after-wrapping-label">
<label>Ablaufdatum</label><input name="cvv" title="Prüfziffer">
<div><span>Not a label</span><input name="plain"></div>`);

	expect(fields.map(({ name, id, label }) => ({ field: name ?? id, label }))).toEqual([
		{ field: "pin", label: "PIN Bank" },
		{ field: "otp", label: "驗證碼" },
		{ field: "pw", label: "Пароль" },
		{ field: "cc", label: "Kartennummer" },
		{ field: "after-wrapping-label", label: undefined },
		{ field: "cvv", label: "Prüfziffer" },
		{ field: "plain", label: undefined },
	]);
	expect(extractWebsiteDataEntryFields(`<div contenteditable="plaintext-only" placeholder="" aria-placeholder="Kode OTP"></div>`)).toEqual([
		{ ref: "f1", control: "div[contenteditable]", placeholder: "Kode OTP" },
	]);
});

test("assigns the same bounded references every time a capture is read", () => {
	const html = `${"<input name=\"x\">".repeat(60)}<input name="${"n".repeat(200)}" placeholder="${"p ".repeat(200)}">`;
	const first = extractWebsiteDataEntryFields(html);

	expect(first).toHaveLength(50);
	expect(first.at(-1)?.ref).toBe("f50");
	expect(extractWebsiteDataEntryFields(html)).toEqual(first);

	const [long] = extractWebsiteDataEntryFields(`<input name="${"n".repeat(200)}" placeholder="${"p  ".repeat(200)}">`);
	expect(long?.name).toHaveLength(120);
	expect(long?.placeholder).toBe("p ".repeat(60).slice(0, 120));
});
