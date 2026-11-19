import { describe, expect, test } from "bun:test";

import { classifySite, type DnsObservation, type SiteObservation } from "./classify";
import { PAGE_SIGNATURES } from "./signatures";

const SITE = "https://secure-login.kit-example.com/account/verify";

type Visit = {
	status?: number;
	headers?: Record<string, string>;
	body?: string;
	/** The redirect chain; the last URL answered. Defaults to the reported URL alone. */
	urls?: string[];
	url?: string;
	dns?: DnsObservation;
	domainStatuses?: string[];
};

function observe(visit: Visit = {}): SiteObservation {
	const url = visit.url ?? SITE;
	const urls = visit.urls ?? [url];
	return {
		url,
		dns: visit.dns ?? { outcome: "resolved", addresses: ["203.0.113.10"] },
		domainStatuses: visit.domainStatuses ?? ["active"],
		http: {
			outcome: "response",
			urls,
			page: { status: visit.status ?? 200, url: urls.at(-1)!, headers: visit.headers ?? { "content-type": "text/html; charset=utf-8" }, ...(visit.body === undefined ? {} : { body: visit.body }) },
		},
	};
}

function classify(visit: Visit = {}) {
	return classifySite(observe(visit));
}

const CLOUDFLARE = { server: "cloudflare", "cf-ray": "8f3a2b1c9d0e4f56-FRA", "content-type": "text/html; charset=UTF-8" };

/** A live phishing kit: a login form with a password field. */
const KIT_PAGE = `<!DOCTYPE html><html><head><title>Sign in to your account</title></head><body>
<form action="/next.php" method="post"><input type="email" name="login"><input type="password" name="passwd"><button>Sign in</button></form></body></html>`;

const CLOUDFLARE_PHISHING_INTERSTITIAL = `<!DOCTYPE html>
<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->
<html lang="en-US">
<head>
<title>Suspected phishing site | Cloudflare</title>
<meta charset="UTF-8" />
<meta name="robots" content="noindex, nofollow" />
<link rel="stylesheet" id="cf_styles-css" href="/cdn-cgi/styles/cf.errors.css" />
</head>
<body>
  <div id="cf-wrapper">
    <div id="cf-error-details" class="p-0">
      <header class="mx-auto pt-10 lg:pt-6 lg:px-8 w-240 lg:w-full mb-8">
        <h1 class="inline-block sm:block sm:mb-2 font-light text-60 lg:text-4xl text-black-dark leading-tight mr-2">
          <span data-translate="phishing_warning_header">Warning: Suspected Phishing Site Ahead!</span>
        </h1>
      </header>
      <section class="w-240 lg:w-full mx-auto mb-8 lg:px-8">
        <p data-translate="phishing_warning_text">This link has been flagged as phishing. We suggest you avoid it.</p>
        <form action="/cdn-cgi/phish-bypass" method="GET" enctype="text/plain">
          <input type="hidden" name="atok" value="b4f2c9e1d7a0" />
          <input type="hidden" name="original_path" value="/account/verify" />
          <button type="submit" class="cf-btn cf-btn-danger" data-translate="dismiss_and_enter">Dismiss this warning and enter site</button>
        </form>
      </section>
      <div class="cf-error-footer cf-wrapper w-240 lg:w-full py-10 sm:py-4 sm:px-8 mx-auto text-center sm:text-left border-solid border-0 border-t border-gray-300">
        <p class="text-13"><span class="cf-footer-item sm:block sm:mb-1">Cloudflare Ray ID: <strong class="font-semibold">8f3a2b1c9d0e4f56</strong></span></p>
      </div>
    </div>
  </div>
</body>
</html>`;

const CLOUDFLARE_PHISHING_INTERSTITIAL_2025 = `<!DOCTYPE html><html lang="en-US"><head><title>Suspected Phishing | Cloudflare</title></head><body>
<div id="cf-wrapper"><h1>Suspected Phishing</h1>
<p>This website has been reported for potential phishing.</p>
<p>Phishing is when a site attempts to steal sensitive information by falsely presenting as a safe source.</p>
<a href="/cdn-cgi/phish-bypass?atok=0f9e8d7c">Ignore &amp; Proceed</a>
<p>Cloudflare Ray ID: 8f3a2b1c9d0e4f57</p></div></body></html>`;

const CLOUDFLARE_CHALLENGE = `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>
<meta http-equiv="refresh" content="390"></head><body><div class="main-wrapper" role="main"><div class="main-content">
<noscript><div class="h2"><span id="challenge-error-text">Enable JavaScript and cookies to continue</span></div></noscript></div></div>
<script>(function(){window._cf_chl_opt={cvId: '3',cZone: "secure-login.kit-example.com",cType: 'managed'};var cpo=document.createElement('script');cpo.src='/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=8f3a2b1c9d0e4f58';window._cf_chl_opt.cOgUHash=location.hash;document.getElementsByTagName('head')[0].appendChild(cpo);}());</script>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script></body></html>`;

const CPANEL_SUSPENDED = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
<title>Account Suspended</title>
<link rel="stylesheet" href="//use.fontawesome.com/releases/v5.0.6/css/all.css">
<style type="text/css">body { font-family: Arial, Helvetica, sans-serif; font-size: 14px; line-height: 1.428571429; background-color: #ffffff; color: #2F3230; padding: 0; margin: 0; }</style>
</head>
<body>
<div class="container">
  <div class="content">
    <i class="fas fa-exclamation-triangle"></i>
    <h1>This Account has been suspended.</h1>
    <p>Contact your hosting provider for more information.</p>
  </div>
</div>
</body>
</html>`;

const FIREBASE_SITE_NOT_FOUND = `<!DOCTYPE html>
<html>
	<head>
		<meta charset="utf-8">
		<meta name="viewport" content="width=device-width, initial-scale=1">
		<title>Site Not Found</title>
		<style media="screen">body { background: #ECEFF1; color: rgba(0,0,0,0.87); font-family: Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; }</style>
	</head>
	<body>
		<div id="message">
			<h2>404</h2>
			<h1>Site Not Found</h1>
			<p>Why am I seeing this?</p>
			<p>There are a few potential reasons:</p>
			<ol>
				<li>You haven't deployed an app yet.</li>
				<li>You may have deployed an empty directory.</li>
				<li>This is a custom domain, but we haven't finished setting it up yet.</li>
			</ol>
			<h3>How can I deploy my first app?</h3>
			<p>Refer to our <a href="https://firebase.google.com/docs/hosting/#quickstart">hosting documentation</a> to get started.</p>
		</div>
	</body>
</html>`;

const GITHUB_PAGES_404 = `<!DOCTYPE html>
<html>
  <head>
    <meta http-equiv="Content-type" content="text/html; charset=utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'">
    <title>Site not found &middot; GitHub Pages</title>
  </head>
  <body>
    <div class="container">
      <h1>404</h1>
      <p><strong>There isn't a GitHub Pages site here.</strong></p>
      <p>If you're trying to publish one, <a href="https://help.github.com/pages/">read the full documentation</a> to learn how to set up <strong>GitHub Pages</strong> for your repository, organization, or user account.</p>
      <div id="suggestions"><a href="https://githubstatus.com">GitHub Status</a> &mdash; <a href="https://twitter.com/githubstatus">@githubstatus</a></div>
    </div>
  </body>
</html>`;

const GODADDY_PARKING_STUB = `<!DOCTYPE html><html><head><script>window.onload=function(){window.location.href="/lander"}</script></head></html>`;

const GODADDY_LANDER = `<!doctype html><html lang="en"><head><meta charset="utf-8"/><title>kit-example.com</title>
<script defer="defer" src="https://img1.wsimg.com/parking-lander/static/js/main.1e1f0a3b.js"></script>
<link href="https://img1.wsimg.com/parking-lander/static/css/main.6a2c8f0e.css" rel="stylesheet"></head>
<body><noscript>You need to enable JavaScript to run this app.</noscript><div id="root"></div></body></html>`;

const SEDO_PARKING = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>kit-example.com</title>
<script type="text/javascript" src="https://img.sedoparking.com/js/jquery-3.5.1.min.js"></script>
</head><body><div id="ads"></div><div class="sale">The domain kit-example.com may be for sale by its owner!</div>
<script>var sedoTracking = "https://sedoparking.com/frmpark/kit-example.com/IONOSParkingDE/park.js";</script></body></html>`;

const BODIS_PARKING = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>kit-example.com</title>
<script>window.park = "eyJ1dWlkIjoiYmY0ZjY5NjEtYzJkZi00YTNhLWE0NTctZWRmZjA3N2Y0ODRmIiwicGFnZV90aW1lIjoxNzMxMDAwMDAwfQ==";</script>
<script src="/bNjEqIiUw.js"></script></head><body><div id="target"></div></body></html>`;

const NAMECHEAP_PARKING = `<!DOCTYPE html><html><head><title>kit-example.com</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
<iframe src="https://parkingpage.namecheap.com/?domain=kit-example.com" frameborder="0"></iframe>
<p>kit-example.com is registered at Namecheap.com</p></body></html>`;

const HOSTINGER_PARKING = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Parked Domain name on Hostinger DNS system</title>
<link rel="stylesheet" href="https://hpanel.hostinger.com/parking/css/app.css"></head><body><h1>kit-example.com</h1>
<p>This domain is parked free of charge with Hostinger.</p></body></html>`;

const FOR_SALE = `<!DOCTYPE html><html><head><title>kit-example.com is for sale</title></head><body><main>
<h1>This domain is for sale!</h1><p>Make an offer today. Secure payment and fast transfer.</p><a href="/offer">Make offer</a></main></body></html>`;

const EXPIRED = `<!DOCTYPE html><html><head><title>kit-example.com</title></head><body><div class="notice">
<h1>This domain has expired.</h1><p>If you are the registered owner, please contact your registrar to renew it.</p></div></body></html>`;

const NAMECHEAP_SUSPENDED = `<!DOCTYPE html><html><head><title>Domain Suspended</title></head><body>
<img src="https://www.namecheap.com/assets/img/logos/namecheap.svg" alt="Namecheap">
<h1>This domain has been suspended</h1><p>Please contact the domain owner or Namecheap support for details.</p></body></html>`;

const ICANN_VERIFICATION_SUSPENDED = `<!DOCTYPE html><html><head><title>Suspended Domain</title></head><body>
<h2>This domain has been suspended due to non-completion of an ICANN-mandated contact verification.</h2>
<p>If you are the registrant, please check your email for the verification link.</p></body></html>`;

const REGISTRAR_SUSPENDED = `<!DOCTYPE html><html><head><title>Notice</title></head><body>
<h1>This domain name has been suspended by the registrar.</h1><p>For more details contact the registrar's abuse department.</p></body></html>`;

describe("the CDN layer", () => {
	test("Cloudflare's phishing interstitial is the CDN blocking the site", () => {
		expect(classify({ status: 403, headers: CLOUDFLARE, body: CLOUDFLARE_PHISHING_INTERSTITIAL })).toEqual({ state: "cdn_blocked", detail: "Cloudflare phishing interstitial (HTTP 403)." });
		expect(classify({ status: 403, headers: CLOUDFLARE, body: CLOUDFLARE_PHISHING_INTERSTITIAL_2025 }).state).toBe("cdn_blocked");
	});

	test("a copy of the interstitial served without Cloudflare is the kit itself", () => {
		// ClearFake replicas imitate the interstitial on attacker servers.
		expect(classify({ status: 200, headers: { server: "nginx" }, body: CLOUDFLARE_PHISHING_INTERSTITIAL }).state).toBe("online");
	});

	test("a Cloudflare bot challenge stands in front of a site that is still served", () => {
		expect(classify({ status: 403, headers: { ...CLOUDFLARE, "cf-mitigated": "challenge" }, body: CLOUDFLARE_CHALLENGE })).toEqual({ state: "online", detail: "Cloudflare bot challenge (HTTP 403)." });
		expect(classify({ status: 503, headers: CLOUDFLARE, body: CLOUDFLARE_CHALLENGE }).state).toBe("online");
	});
});

describe("the hosting layer", () => {
	test("cPanel's suspension page, served in place or through its redirect", () => {
		expect(classify({ body: CPANEL_SUSPENDED })).toEqual({ state: "host_suspended", detail: "cPanel account suspension page (HTTP 200)." });
		const redirected = classify({
			urls: [SITE, "https://secure-login.kit-example.com/cgi-sys/suspendedpage.cgi"],
			body: "<html><head><title>Website Suspended</title></head><body><h1>Website suspended</h1></body></html>",
		});
		expect(redirected.state).toBe("host_suspended");
	});

	test("Render's suspension wins over its 503", () => {
		expect(classify({ status: 503, headers: { "x-render-routing": "suspend-by-user", "content-type": "text/plain" }, body: "This service has been suspended by its owner." }))
			.toEqual({ state: "host_suspended", detail: "Render service suspension (HTTP 503)." });
		expect(classify({ status: 503, headers: { "content-type": "text/html" }, body: "<html><head><title>Service Suspended</title></head><body>This service has been suspended.</body></html>" }).state).toBe("host_suspended");
	});

	test("Vercel's disabled and blocked deployments", () => {
		expect(classify({ status: 402, headers: { server: "Vercel", "x-vercel-error": "DEPLOYMENT_DISABLED" }, body: "402: PAYMENT_REQUIRED\nCode: DEPLOYMENT_DISABLED" }).state).toBe("host_suspended");
		expect(classify({ status: 403, headers: { server: "Vercel", "x-vercel-error": "DEPLOYMENT_BLOCKED" }, body: "403: FORBIDDEN\nCode: DEPLOYMENT_BLOCKED" }).state).toBe("host_suspended");
		expect(classify({ status: 451, headers: { server: "Vercel" }, body: "<h1>451: UNAVAILABLE_FOR_LEGAL_REASONS</h1><p>Code: DEPLOYMENT_DISABLED</p><p>This Deployment has been disabled.</p>" }))
			.toEqual({ state: "host_suspended", detail: "Vercel disabled deployment (HTTP 451)." });
	});

	test("platform suspension and unavailability pages", () => {
		const cases: Array<[string, Visit]> = [
			["Netlify site suspension", { status: 503, body: `<html><head><title>Site not available</title></head><body><h1>Site not available</h1><p>This site was paused as it reached its usage limits.</p><a href="https://www.netlify.com">Netlify</a></body></html>` }],
			["Hostinger website suspension", { body: `<html><head><title>Website suspended</title><link href="https://cdn.hostinger.com/suspended.css" rel="stylesheet"></head><body><h1>This website is temporarily unavailable</h1></body></html>` }],
			["Firebase Hosting site not found", { status: 404, body: FIREBASE_SITE_NOT_FOUND }],
			["Wix site disconnected", { status: 404, body: `<html><head><title>Wix.com</title></head><body><h1>Looks Like This Domain Isn&#x27;t Connected To A Website Yet!</h1></body></html>` }],
			["Weebly site suspension", { body: `<html><head><title>Weebly</title><link rel="stylesheet" href="https://cdn2.editmysite.com/css/weebly.css"></head><body><h2>This site has been suspended for violating Weebly's Terms of Service.</h2></body></html>` }],
			["Shopify store unavailable", { status: 402, body: `<html><head><title>Store unavailable</title></head><body><h1>Sorry, this shop is currently unavailable.</h1></body></html>` }],
			["Terms-of-service takedown notice", { body: `<html><body><p>This page has been taken down for viewing because it violates the Terms of Service or Program Policies.</p></body></html>`, url: "https://sites.google.com/view/kit-example/home" }],
			["Hosting suspension page", { body: `<html><head><title>Suspended</title></head><body><h1>This website has been suspended.</h1><p>Please contact the server administrator.</p></body></html>` }],
		];
		for (const [name, visit] of cases) {
			expect({ name, ...classify(visit) }).toMatchObject({ name, state: "host_suspended", detail: expect.stringContaining(name) });
		}
	});

	test("platforms answering for a site that no longer exists name it", () => {
		const cases: Array<[string, Visit]> = [
			["GitHub Pages: no site here", { status: 404, headers: { server: "GitHub.com" }, body: GITHUB_PAGES_404, url: "https://kit-example.github.io/login/" }],
			["Vercel deployment not found", { status: 404, headers: { server: "Vercel", "x-vercel-error": "DEPLOYMENT_NOT_FOUND" }, body: "The deployment could not be found on Vercel.\n\nDEPLOYMENT_NOT_FOUND\n" }],
			["Netlify site not found", { status: 404, headers: { server: "Netlify" }, body: "Not Found - Request ID: 01M7T9XXSYJXD34S9DBT39R84Q" }],
			["Render service not found", { status: 404, headers: { "x-render-routing": "no-server" }, body: "Not Found" }],
			["Heroku app not found", { status: 404, body: `<!DOCTYPE html><html><head><title>No such app</title></head><body><iframe src="https://www.herokucdn.com/error-pages/no-such-app.html"></iframe></body></html>` }],
			["Surge project not found", { status: 404, headers: { server: "Surge" }, body: "<html><head><title>project not found</title></head><body>project not found</body></html>" }],
			["Framer site not found", { status: 404, body: "<html><head><title>Site Not Found | Framer</title></head><body>Site not found</body></html>" }],
			["Replit app not live", { status: 404, body: "<html><head><title>This app isn&#39;t live yet</title></head></html>" }],
			["Glitch project hosting ended", { status: 410, body: "<html><body><h1>Well, you found a glitch.</h1><p>Glitch project hosting is no longer available.</p></body></html>" }],
			["Storage bucket deleted", { status: 404, headers: { "content-type": "application/xml" }, body: "<?xml version='1.0' encoding='UTF-8'?><Error><Code>NoSuchBucket</Code><Message>The specified bucket does not exist.</Message></Error>" }],
		];
		for (const [name, visit] of cases) {
			expect({ name, ...classify(visit) }).toMatchObject({ name, state: "removed", detail: expect.stringContaining(name) });
		}
	});
});

describe("the registrar layer", () => {
	test("parking and for-sale pages", () => {
		const cases: Array<[string, Visit]> = [
			["GoDaddy parking page", { body: GODADDY_PARKING_STUB }],
			["GoDaddy parking page", { body: GODADDY_LANDER }],
			["Sedo parking page", { body: SEDO_PARKING }],
			["Bodis parking page", { body: BODIS_PARKING }],
			["ParkingCrew parking page", { body: `<html><head><script src="https://www.parkingcrew.net/assets/scripts/main.js"></script></head></html>` }],
			["Namecheap parking page", { body: NAMECHEAP_PARKING }],
			["Hostinger parking page", { body: HOSTINGER_PARKING }],
			["Dynadot parking page", { body: "<html><body><p>kit-example.com is parked free of charge with Dynadot.</p></body></html>" }],
			["Domain for sale page", { body: FOR_SALE }],
			["Expired domain page", { body: EXPIRED }],
		];
		for (const [name, visit] of cases) {
			expect({ name, ...classify(visit) }).toMatchObject({ name, state: "parked", detail: expect.stringContaining(name) });
		}
	});

	test("a marketplace the site redirects to is a parking page, not a redirect", () => {
		const marketplaces: Array<[string, string]> = [
			["HugeDomains for-sale page", "https://www.hugedomains.com/domain_profile.cfm?d=kit-example.com"],
			["Dan.com for-sale page", "https://dan.com/buy-domain/kit-example.com"],
			["Afternic for-sale page", "https://www.afternic.com/forsale/kit-example.com"],
			["Sedo for-sale page", "https://sedo.com/search/details/?domain=kit-example.com"],
		];
		for (const [name, landing] of marketplaces) {
			expect(classify({ urls: [SITE, "https://kit-example.com/", landing], body: "<html><body><h1>Buy now</h1></body></html>" }))
				.toEqual({ state: "parked", detail: `${name} (HTTP 200).` });
		}
	});

	test("registrar suspension pages", () => {
		expect(classify({ body: NAMECHEAP_SUSPENDED }).detail).toBe("Namecheap domain suspension page (HTTP 200).");
		expect(classify({ body: ICANN_VERIFICATION_SUSPENDED }).detail).toBe("ICANN contact verification suspension page (HTTP 200).");
		expect(classify({ body: REGISTRAR_SUSPENDED }).detail).toBe("Registrar domain suspension page (HTTP 200).");
		expect(classify({ body: `<html><body><img src="/gname-logo.png" alt="Gname"><h1>The domain is suspended.</h1></body></html>` }).detail).toBe("Gname domain suspension page (HTTP 200).");
		for (const body of [NAMECHEAP_SUSPENDED, ICANN_VERIFICATION_SUSPENDED, REGISTRAR_SUSPENDED]) expect(classify({ body }).state).toBe("domain_suspended");
	});

	test("an RDAP hold suspends the domain whatever the page shows", () => {
		for (const status of ["client hold", "server hold", "clientHold", "serverHold", "client_hold"]) {
			expect(classify({ body: KIT_PAGE, domainStatuses: ["client transfer prohibited", status] })).toEqual({ state: "domain_suspended", detail: `The registry lists the domain as ${status}.` });
		}
		expect(classify({ status: 503, body: CPANEL_SUSPENDED, domainStatuses: ["serverHold"] }).state).toBe("domain_suspended");
		expect(classify({ body: KIT_PAGE, domainStatuses: ["client transfer prohibited", "client update prohibited", "active"] }).state).toBe("online");
	});

	test("a name that is gone outranks a hold", () => {
		const gone = { outcome: "nxdomain" as const };
		expect(classifySite({ url: SITE, dns: gone, domainStatuses: ["client hold"] })).toEqual({ state: "domain_gone", detail: "secure-login.kit-example.com no longer resolves (NXDOMAIN)." });
	});

	test("a host whose CNAME target or platform tenancy is gone was removed by its host", () => {
		expect(classifySite({ url: SITE, dns: { outcome: "nxdomain", cname: "kit-example.pages.dev" }, domainStatuses: [] }))
			.toEqual({ state: "removed", detail: "The site's CNAME target kit-example.pages.dev no longer exists (NXDOMAIN)." });
		expect(classifySite({ url: "https://kit-example.pages.dev/login", dns: { outcome: "nxdomain" }, domainStatuses: [] }))
			.toEqual({ state: "removed", detail: "The platform pages.dev no longer has kit-example.pages.dev (NXDOMAIN)." });
		expect(classifySite({ url: "https://login.kit-example.workers.dev/", dns: { outcome: "nxdomain" }, domainStatuses: [] }).state).toBe("removed");
	});
});

describe("pages that only look like takedowns", () => {
	test("a kit quoting a suspension or renewal page to phish credentials is online", () => {
		const accountLure = `<html><head><title>Account Suspended</title></head><body><h1>This website has been suspended</h1>
<p>Verify your identity to restore access.</p><form><input name="email"><input type="password" name="pass"></form></body></html>`;
		const renewalLure = `<html><body><h1>This domain has expired</h1><p>Renew now to keep your website online.</p>
<form><input name="cardnumber" autocomplete="cc-number"><input name="cvv"></form></body></html>`;
		const cardOnly = `<html><body><h1>The domain kit-example.com has expired</h1><form><input name="card_number"><input name="exp"></form></body></html>`;
		expect(classify({ body: accountLure }).state).toBe("online");
		expect(classify({ body: renewalLure }).state).toBe("online");
		expect(classify({ body: cardOnly }).state).toBe("online");
	});

	test("an account lure without the hosting wording does not match a suspension page", () => {
		const lure = `<html><head><title>Your account has been suspended</title></head><body><h1>Your account has been suspended</h1><a href="/appeal">Appeal now</a></body></html>`;
		expect(classify({ body: lure }).state).toBe("online");
	});

	test("every signature has a name and a state", () => {
		for (const signature of PAGE_SIGNATURES) {
			expect(signature.name.length).toBeGreaterThan(3);
			expect(signature.url ?? signature.headers ?? signature.body).toBeDefined();
		}
	});
});

describe("redirects", () => {
	test("a chain that ends on another registrable domain is redirected", () => {
		expect(classify({ urls: [SITE, "https://www.google.com/"], body: "<html><title>Google</title></html>" })).toEqual({ state: "redirected", detail: "Redirected to www.google.com (HTTP 200)." });
	});

	test("a chain within the same registrable domain is the site", () => {
		expect(classify({ urls: ["http://kit-example.com/", "https://kit-example.com/", SITE], body: KIT_PAGE }).state).toBe("online");
	});

	test("one platform tenant redirecting to another leaves the site", () => {
		expect(classify({ url: "https://kit-a.pages.dev/", urls: ["https://kit-a.pages.dev/", "https://kit-b.pages.dev/"], body: KIT_PAGE }).state).toBe("redirected");
		expect(classify({ url: "https://kit-a.pages.dev/", urls: ["https://kit-a.pages.dev/", "https://www.kit-a.pages.dev/"], body: KIT_PAGE }).state).toBe("online");
	});

	test("a redirect that ends on a missing page is still a redirect", () => {
		expect(classify({ status: 404, urls: [SITE, "https://example.org/missing"], body: "<html>Not found</html>" }).state).toBe("redirected");
	});

	test("an IP target redirecting to a domain leaves the site", () => {
		expect(classify({ url: "http://203.0.113.10/login", urls: ["http://203.0.113.10/login", "https://kit-example.com/login"], body: KIT_PAGE }).state).toBe("redirected");
	});
});

describe("HTTP status", () => {
	test("gone pages are removed", () => {
		expect(classify({ status: 404, body: "<html><body>Not Found</body></html>" })).toEqual({ state: "removed", detail: "HTTP 404." });
		expect(classify({ status: 410 })).toEqual({ state: "removed", detail: "HTTP 410." });
	});

	test("451 is the host blocking the page", () => {
		expect(classify({ status: 451, body: "Unavailable For Legal Reasons" })).toEqual({ state: "host_suspended", detail: "HTTP 451." });
	});

	test("server errors are unreachable", () => {
		for (const status of [500, 502, 503, 504, 521, 522, 530]) expect(classify({ status, body: "<html>error</html>" })).toEqual({ state: "unreachable", detail: `HTTP ${status}.` });
	});

	test("any other answer is the site", () => {
		for (const status of [200, 201, 204, 401, 403, 429]) expect(classify({ status, body: KIT_PAGE }).state).toBe("online");
		expect(classify({ status: 200 })).toEqual({ state: "online", detail: "HTTP 200." });
	});
});

describe("failures", () => {
	test("no HTTP answer is unreachable with its cause", () => {
		const observation: SiteObservation = { url: SITE, dns: { outcome: "resolved", addresses: ["203.0.113.10"] }, domainStatuses: [], http: { outcome: "failed", error: "ECONNREFUSED: Unable to connect.", urls: [SITE] } };
		expect(classifySite(observation)).toEqual({ state: "unreachable", detail: "No answer: ECONNREFUSED: Unable to connect." });
	});

	test("a resolver that did not answer leaves the decision to the visit", () => {
		const servfail = { outcome: "failed" as const, error: "ESERVFAIL" };
		expect(classify({ dns: servfail, body: KIT_PAGE }).state).toBe("online");
		expect(classifySite({ url: SITE, dns: servfail, domainStatuses: [], http: { outcome: "failed", error: "the request timed out after 15 s.", urls: [SITE] } }).state).toBe("unreachable");
		expect(classifySite({ url: SITE, dns: servfail, domainStatuses: [] })).toEqual({ state: "unreachable", detail: "DNS failed: ESERVFAIL" });
	});
});
