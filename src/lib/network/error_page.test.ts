import { describe, expect, test } from "bun:test";

import { classifyBareErrorPage, visibleText } from "./error_page";

const page = (title: string, body: string) => `<!DOCTYPE html><html><head><title>${title}</title><style>body{color:red}</style></head><body>${body}<script>var x = "Not Found";</script></body></html>`;

describe("a bare error page, by its content alone", () => {
	test("servers' and hosts' not-found pages", () => {
		for (const html of [
			page("404 Not Found", "<center><h1>404 Not Found</h1></center><hr><center>nginx/1.24.0</center>"),
			page("404 Not Found", "<h1>Not Found</h1><p>The requested URL was not found on this server.</p><address>Apache/2.4.41 (Ubuntu) Server at kit.example Port 443</address>"),
			page("The resource cannot be found.", "<h2>404 - File or directory not found.</h2>"),
			page("410 Gone", "<h1>410 Gone</h1>"),
			page("451 Unavailable For Legal Reasons", "<h1>Unavailable For Legal Reasons</h1>"),
			page("Page Not Found", "<p>Sorry, this page doesn't exist.</p>"),
			"Not Found",
			"File not found.",
		]) expect(classifyBareErrorPage({ html })).toBe("not_found");
	});

	test("gateway, upstream and server errors, Cloudflare's origin errors among them", () => {
		for (const html of [
			page("500 Internal Server Error", "<h1>Internal Server Error</h1>"),
			page("502 Bad Gateway", "<center><h1>502 Bad Gateway</h1></center>"),
			page("503 Service Unavailable", "<h1>Service Temporarily Unavailable</h1>"),
			page("504 Gateway Time-out", "<h1>504 Gateway Time-out</h1>"),
			page("kit.example | 521: Web server is down", "Web server is down Error code 521"),
			page("kit.example | 521: Web server is down", `<div id="cf-error-details"><h1>Web server is down</h1><p>Error code 521</p><span>Cloudflare Ray ID: 8f3a2b1c</span></div>`),
			page("kit.example | 522: Connection timed out", "Connection timed out Error code 522"),
			page("kit.example | 523: Origin is unreachable", "Origin is unreachable"),
		]) expect(classifyBareErrorPage({ html })).toBe("server_error");
	});

	test("WAFs and CDNs turning the network away", () => {
		for (const html of [
			page("Attention Required! | Cloudflare", "<h1>Sorry, you have been blocked</h1><h2>You are unable to access kit.example</h2>"),
			page("Access denied | kit.example used Cloudflare to restrict access", "Error 1020 Ray ID: 8f3a2b1c9d0e4f56"),
			page("Access Denied", "You don't have permission to access \"http://kit.example/\" on this server. Reference #18.3c2f1402.1700000000.1a2b3c"),
			page("", "Request unsuccessful. Incapsula incident ID: 1234-5678"),
			page("Sucuri WebSite Firewall - Access Denied", "Access Denied - Sucuri Website Firewall"),
			page("403 Forbidden", "<h1>403 Forbidden</h1>"),
			page("Forbidden", "<p>Your IP has been blocked.</p>"),
		]) expect(classifyBareErrorPage({ html })).toBe("blocked");
		expect(classifyBareErrorPage({ html: page("kit.example", "One moment"), headers: { "x-amzn-waf-action": "block" } })).toBe("blocked");
	});

	test("a vendor's full block page is told by its signatures at any length, its links and boilerplate included", () => {
		const cloudflare = `<!DOCTYPE html><html lang="en-US"><head><title>Attention Required! | Cloudflare</title></head><body>
<div id="cf-wrapper"><div class="cf-alert cf-alert-error cf-cookie-error" id="cookie-alert">Please enable cookies.</div>
<div id="cf-error-details" class="cf-error-details-wrapper"><div class="cf-wrapper cf-header cf-error-overview"><h1 data-translate="block_headline">Sorry, you have been blocked</h1>
<h2 class="cf-subheadline"><span data-translate="unable_to_access">You are unable to access</span> kit-example.com</h2></div>
<div class="cf-section cf-wrapper"><div class="cf-columns two"><div class="cf-column"><h2 data-translate="blocked_why_headline">Why have I been blocked?</h2>
<p data-translate="blocked_why_detail">This website is using a security service to protect itself from online attacks. The action you just performed triggered the security solution. There are several actions that could trigger this block including submitting a certain word or phrase, a SQL command or malformed data.</p></div>
<div class="cf-column"><h2 data-translate="blocked_resolve_headline">What can I do to resolve this?</h2>
<p data-translate="blocked_resolve_detail">You can email the site owner to let them know you were blocked. Please include what you were doing when this page came up and the Cloudflare Ray ID found at the bottom of this page.</p></div></div></div>
<div class="cf-error-footer cf-wrapper w-240 lg:w-full py-10 sm:py-4 sm:px-8 mx-auto text-center sm:text-left border-solid border-0 border-t border-gray-300">
<p class="text-13"><span class="cf-footer-item sm:block sm:mb-1">Cloudflare Ray ID: <strong class="font-semibold">8f3a2b1c9d0e4f56</strong></span><span class="cf-footer-separator sm:hidden">&bull;</span>
<span id="cf-footer-item-ip" class="cf-footer-item hidden sm:block sm:mb-1">Your IP: <button type="button" id="cf-footer-ip-reveal" class="cf-footer-ip-reveal-btn">Click to reveal</button><span class="hidden" id="cf-footer-ip">203.0.113.7</span></span>
<span class="cf-footer-item sm:block sm:mb-1"><span>Performance &amp; security by</span> <a rel="noopener noreferrer" href="https://www.cloudflare.com/5xx-error-landing" id="brand_link" target="_blank">Cloudflare</a></span></p></div></div></body></html>`;
		expect(visibleText(cloudflare).length).toBeGreaterThan(700);
		expect(classifyBareErrorPage({ html: cloudflare })).toBe("blocked");
		const sucuri = `<!DOCTYPE html><html><head><title>Sucuri WebSite Firewall - Access Denied</title></head><body><div id="main-container"><div id="error-container">
<h1>Access Denied - Sucuri Website Firewall</h1><p>If you are the site owner (or you manage this site), please whitelist your IP or if you think this block is an error please <a href="https://support.sucuri.net/">open a support ticket</a> and make sure to include the block details (displayed in the box below), so we can assist you in troubleshooting the issue.</p>
<h2>Block details:</h2><table><tr><td>Your IP:</td><td>203.0.113.7</td></tr><tr><td>URL:</td><td>kit-example.com/login</td></tr><tr><td>Your Browser:</td><td>Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36</td></tr>
<tr><td>Block ID:</td><td>BNP005</td></tr><tr><td>Block reason:</td><td>Bad bot access attempt.</td></tr><tr><td>Time:</td><td>2026-11-23 12:00:00</td></tr><tr><td>Server ID:</td><td>14013</td></tr></table></div>
<p>Sucuri Website Firewall - CloudProxy - <a href="https://sucuri.net/website-firewall/">Website Firewall</a> - <a href="https://sucuri.net/website-firewall/?privacy">Privacy</a></p></div></body></html>`;
		expect(visibleText(sucuri).length).toBeGreaterThan(600);
		expect(classifyBareErrorPage({ html: sucuri })).toBe("blocked");
		const cloudfront = page("ERROR: The request could not be satisfied", "<h1>403 ERROR</h1><h2>The request could not be satisfied.</h2><p>Request blocked. We can't connect to the server for this app or website at this time.</p><hr>Generated by cloudfront (CloudFront)<br>Request ID: Zq3x8sGd2lP_aGv0yk2nqf3rQh6pqbo8==");
		expect(classifyBareErrorPage({ html: cloudfront })).toBe("blocked");
		// Even a vendor's page is the site when it asks for anything.
		expect(classifyBareErrorPage({ html: cloudflare.replace("</body>", "<form><input name=email></form></body>") })).toBeUndefined();
	});

	test("a short lure that speaks of blocks or denied access, with something to act on, is a page of the site", () => {
		expect(classifyBareErrorPage({ html: page("Microsoft 365", "<h2>Access denied: your Microsoft 365 session has expired.</h2><p>Click below to re-authenticate and view the shared file.</p><a href=\"https://kit.example/auth\">View Document</a>") })).toBeUndefined();
		expect(classifyBareErrorPage({ html: page("PayPal", "<p>Your IP address has been blocked due to suspicious activity on your PayPal account.</p><button onclick=\"location.href='/restore'\">Restore access</button>") })).toBeUndefined();
		// Without anything to act on, the same words are no server's error either.
		expect(classifyBareErrorPage({ html: page("PayPal", "<p>Your IP address has been blocked due to suspicious activity on your PayPal account.</p>") })).toBeUndefined();
		expect(classifyBareErrorPage({ html: page("Microsoft 365", "<h2>Access denied: your Microsoft 365 session has expired.</h2>") })).toBeUndefined();
		// A bare not-found page with a link home is not bare.
		expect(classifyBareErrorPage({ html: page("Page Not Found", "<h1>Not Found</h1><a href=\"/\">Home</a>") })).toBeUndefined();
	});

	test("a plain-text server error is told from its text alone", () => {
		expect(classifyBareErrorPage({ title: "", text: "404 page not found" })).toBe("not_found");
		expect(classifyBareErrorPage({ title: "", text: "502 Bad Gateway" })).toBe("server_error");
		expect(classifyBareErrorPage({ title: "", text: "no healthy upstream" })).toBe("server_error");
		expect(classifyBareErrorPage({ title: "", text: "RBAC: access denied" })).toBe("blocked");
	});

	test("a page of a site is none, whatever it says: a form, a field, real text, or no error at all", () => {
		expect(classifyBareErrorPage({ html: page("404 Not Found", "<h1>Not Found</h1><form action=/search><button>Search</button></form>") })).toBeUndefined();
		expect(classifyBareErrorPage({ html: page("Forbidden", "<h1>Forbidden</h1><input type=password name=p>") })).toBeUndefined();
		expect(classifyBareErrorPage({ html: page("Login", "<textarea></textarea>") })).toBeUndefined();
		expect(classifyBareErrorPage({ html: page("500 Internal Server Error", `<p>${"Your mailbox needs to be verified to keep receiving mail. ".repeat(15)}</p>`) })).toBeUndefined();
		// survey.centripe.com's lure under HTTP 500.
		expect(classifyBareErrorPage({ html: `<html id="__next_error__"><head><title>Midsona Finland Oy</title></head><body>Uusi asiakirja on jaettu sinulle <a>AVAA</a> Microsoft SharePoint</body></html>` })).toBeUndefined();
		expect(classifyBareErrorPage({ html: page("Just a moment...", "<div>Verify you are human</div>") })).toBeUndefined();
		// A hidden input is no field a visitor fills in; an empty page has nothing to tell.
		expect(classifyBareErrorPage({ html: page("404 Not Found", "<h1>Not Found</h1><input type=hidden name=t value=1>") })).toBe("not_found");
		expect(classifyBareErrorPage({ html: "" })).toBeUndefined();
		expect(classifyBareErrorPage({ html: "<html><head></head><body>  </body></html>" })).toBeUndefined();
	});

	test("the text and title given win over the markup", () => {
		expect(classifyBareErrorPage({ title: "502 Bad Gateway", text: "", html: "<html></html>" })).toBe("server_error");
		expect(classifyBareErrorPage({ title: "Sign in", text: "Welcome back", html: page("404 Not Found", "Not Found") })).toBeUndefined();
	});
});

test("visible text leaves out scripts, styles and markup, and decodes entities", () => {
	expect(visibleText(page("T", "<p>A&nbsp;&amp;&lt;b&gt;</p>\n\n<p>C</p>"))).toBe("A &<b> C");
});