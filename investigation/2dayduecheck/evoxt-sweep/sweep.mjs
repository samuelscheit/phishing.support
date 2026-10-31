import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";

const DOMAIN = "2dayduecheck.website";
const RESOURCE_PATH = "/res/css/style.css?v=6";
const EXPECTED_SHA256 = "86caf93e41826d4c8518cc91df16ea5f0fd2d13151a058b0a170241dcc7cdbbd";
const SESSION_PATH = "/?session=a207adf3-d9ca-4fde-ad59-330d6d0f8d03";
const KIT_MARKERS = ["signin-card", "authenticator-code", "backup-code"];
const TIMEOUT_MS = 1_500;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const CONCURRENCY = 768;

function addresses(prefixes) {
	const result = [];
	for (const prefix of prefixes.trim().split(/\s+/)) {
		const match = prefix.match(/^(\d+)\.(\d+)\.(\d+)\.0\/24$/);
		if (!match) throw new Error(`This evidence sweep expects an IPv4 /24, received ${prefix}`);
		for (let last = 0; last < 256; last++) result.push(`${match[1]}.${match[2]}.${match[3]}.${last}`);
	}
	return result;
}

function probe(ip, secure, requestPath) {
	return new Promise((resolve) => {
		const client = secure ? https : http;
		let settled = false;
		let certificate;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			request.destroy();
			resolve(result);
		};
		const request = client.request({
			host: ip,
			port: secure ? 443 : 80,
			servername: secure ? DOMAIN : undefined,
			path: requestPath,
			method: "GET",
			headers: { Host: DOMAIN, Accept: "text/css,*/*;q=0.1", Connection: "close", "User-Agent": "phishing.support-evidence-sweep/1.0" },
			rejectUnauthorized: false,
			timeout: TIMEOUT_MS,
		}, (response) => {
			const hash = createHash("sha256");
			const chunks = [];
			let bytes = 0;
			response.on("data", (chunk) => {
				bytes += chunk.byteLength;
				if (bytes > MAX_BODY_BYTES) return finish({ status: response.statusCode, oversized: true, certificate });
				hash.update(chunk);
				chunks.push(chunk);
			});
			response.once("end", () => {
				const body = Buffer.concat(chunks).toString("utf8");
				finish({
					status: response.statusCode,
					server: response.headers.server,
					cfRay: response.headers["cf-ray"],
					bytes,
					sha256: hash.digest("hex"),
					markers: KIT_MARKERS.filter((marker) => body.includes(marker)),
					certificate,
				});
			});
			response.once("error", () => finish({ certificate }));
		});
		if (secure) request.once("socket", (socket) => socket.once("secureConnect", () => {
			const peer = socket.getPeerCertificate();
			if (peer?.fingerprint256) certificate = {
				fingerprint256: peer.fingerprint256,
				subjectAltName: peer.subjectaltname,
				issuer: peer.issuer,
			};
		}));
		request.once("timeout", () => finish({ certificate }));
		request.once("error", () => finish({ certificate }));
		request.end();
	});
}

const ips = addresses(await readFile(new URL("./ipv4-prefixes.txt", import.meta.url), "utf8"));
const summary = {
	type: "summary",
	domain: DOMAIN,
	resourcePath: RESOURCE_PATH,
	expectedSha256: EXPECTED_SHA256,
	sessionPath: SESSION_PATH,
	kitMarkers: KIT_MARKERS,
	addressesPlanned: ips.length,
	addressesScanned: 0,
	httpResponses: 0,
	httpsResponses: 0,
	certificateCandidates: 0,
	exactHttpMatches: 0,
	exactHttpsMatches: 0,
	cloudflareExactMatches: 0,
	httpSessionKitMatches: 0,
	httpsSessionKitMatches: 0,
	startedAt: new Date().toISOString(),
};
let next = 0;
const workers = Array.from({ length: CONCURRENCY }, async () => {
	while (next < ips.length) {
		const ip = ips[next++];
		const [plainResource, secureResource, plainSession, secureSession] = await Promise.all([
			probe(ip, false, RESOURCE_PATH),
			probe(ip, true, RESOURCE_PATH),
			probe(ip, false, SESSION_PATH),
			probe(ip, true, SESSION_PATH),
		]);
		summary.addressesScanned++;
		if (plainResource.status || plainSession.status) summary.httpResponses++;
		if (secureResource.status || secureSession.status) summary.httpsResponses++;
		const certificate = secureResource.certificate ?? secureSession.certificate;
		const certificateCandidate = certificate?.subjectAltName?.toLowerCase().includes(`dns:${DOMAIN}`) ?? false;
		if (certificateCandidate) summary.certificateCandidates++;
		const exactHttp = plainResource.status === 200 && plainResource.sha256 === EXPECTED_SHA256;
		const exactHttps = secureResource.status === 200 && secureResource.sha256 === EXPECTED_SHA256;
		if (exactHttp) summary.exactHttpMatches++;
		if (exactHttps) summary.exactHttpsMatches++;
		const httpSessionKit = KIT_MARKERS.every((marker) => plainSession.markers?.includes(marker));
		const httpsSessionKit = KIT_MARKERS.every((marker) => secureSession.markers?.includes(marker));
		if (httpSessionKit) summary.httpSessionKitMatches++;
		if (httpsSessionKit) summary.httpsSessionKitMatches++;
		const cloudflare = [secureResource, secureSession].some((result) => result.cfRay || String(result.server ?? "").toLowerCase().includes("cloudflare"));
		if (exactHttps && cloudflare) summary.cloudflareExactMatches++;
		if (certificateCandidate || exactHttp || exactHttps || httpSessionKit || httpsSessionKit) {
			process.stdout.write(`${JSON.stringify({ type: "candidate", ip, certificateCandidate, exactHttp, exactHttps, httpSessionKit, httpsSessionKit, cloudflare, http: { resource: plainResource, session: plainSession }, https: { resource: secureResource, session: secureSession } })}\n`);
		}
	}
});
await Promise.all(workers);
summary.completedAt = new Date().toISOString();
process.stdout.write(`${JSON.stringify(summary)}\n`);
