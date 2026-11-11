import { describe, expect, test } from "bun:test";

import { withoutCdnInjections } from "./cdn_injections";

/** The tag Cloudflare Web Analytics put into production case 377486973465530391's loader frame. */
const BEACON = `<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js/vce701823e78c4301a35b7e07294d87301792088814092" integrity="sha512-UKNk8GbxkABxKcXYuLkO16EleLGUkcvJWtpSNmExE0Too3ZaFAxTscNWEc1OdAv5/BikHawapSCaiD2XCmp+Bw==" data-cf-beacon='{"version":"2024.11.0","token":"58ce29bb83e14700a8210b4a78f3510e","r":1,"spa":2}' crossorigin="anonymous"></script>\n`;
const CHALLENGE = `<script>(function(){function c(){var b=a.contentDocument||a.contentWindow.document;if(b){var d=b.createElement('script');d.innerHTML="window.__CF$cv$params={r:'99a1b2c3d4e5f607',t:'MTc5NDA4MDQzMC4wMDAwMDA='};var a=document.createElement('script');a.nonce='';a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';document.getElementsByTagName('head')[0].appendChild(a);";b.getElementsByTagName('head')[0].appendChild(d)}}if(document.body){var a=document.createElement('iframe');a.height=1;a.width=1;a.style.position='absolute';a.style.top=0;a.style.left=0;a.style.border='none';a.style.visibility='hidden';document.body.appendChild(a);c()}})();</script>`;
const ORIGIN = "<html><body>\n\t<script>main();</script> \n</body>\n</html>\n";
const served = (...injections: string[]) => ORIGIN.replace("</body>", `${injections.join("")}</body>`);

describe("CDN injections", () => {
	test("the Cloudflare beacon line and challenge script come out, giving back the origin's bytes", () => {
		expect(withoutCdnInjections(Buffer.from(served(BEACON)))?.toString()).toBe(ORIGIN);
		expect(withoutCdnInjections(Buffer.from(served(BEACON.replace('type="module"', "defer"))))?.toString()).toBe(ORIGIN);
		expect(withoutCdnInjections(Buffer.from(served(CHALLENGE)))?.toString()).toBe(ORIGIN);
		expect(withoutCdnInjections(Buffer.from(served(BEACON, CHALLENGE)))?.toString()).toBe(ORIGIN);
	});

	test("a document the CDN left alone is not a second copy", () => {
		expect(withoutCdnInjections(Buffer.from(ORIGIN))).toBeUndefined();
		expect(withoutCdnInjections(Buffer.alloc(0))).toBeUndefined();
	});

	test("the page's own scripts stay, even ones that name the beacon or the challenge path in their code", () => {
		const own = `<script src="https://cdn.example.net/beacon.min.js"></script><script>fetch("/cdn-cgi/trace")</script><script src="/js/static.cloudflareinsights.com.js"></script>`;
		expect(withoutCdnInjections(Buffer.from(served(own)))).toBeUndefined();
		expect(withoutCdnInjections(Buffer.from(served(own, BEACON)))?.toString()).toBe(served(own));
	});

	test("every other byte survives, whatever the document's encoding", () => {
		const gbk = Buffer.concat([Buffer.from("<html><body><p>"), Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xff, 0x00]), Buffer.from("</p>"), Buffer.from(BEACON), Buffer.from("</body></html>")]);
		const expected = Buffer.concat([Buffer.from("<html><body><p>"), Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xff, 0x00]), Buffer.from("</p></body></html>")]);
		expect(withoutCdnInjections(gbk)?.equals(expected)).toBe(true);
	});
});
