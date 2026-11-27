import { describe, expect, test } from "bun:test";

import type { ObservedResponse } from "../../browser/tab_traffic";
import type { DocumentAnswer } from "./document_bodies";
import { MAX_TAB_BODY_BYTES, MAX_UNCLAIMED_ANSWERS, recordTab } from "./tab_recording";

const MB = 1024 * 1024;

/** A main-frame document the tab showed, after `redirects`. */
function shown(url: string, redirects: Array<{ url: string; status: number }> = [], status = 200): ObservedResponse {
	return {
		url,
		status,
		headers: { "content-type": "text/html" },
		resourceType: "document",
		mainFrameNavigation: true,
		redirects: redirects.map(({ url: from, status }) => ({ url: from, status, headers: {} })),
		body: async () => Buffer.alloc(0),
	};
}

/** An answer the network layer held `at` milliseconds into the visit. */
function answer(url: string, at: number, body?: string | Buffer, status = 200): DocumentAnswer {
	return { url, status, receivedAt: new Date(Date.UTC(2026, 10, 23, 12, 0, 0, at)).toISOString(), ...(body === undefined ? {} : { body: Buffer.from(body) }) };
}

const bodyOf = (recording: ReturnType<typeof recordTab>, index: number) => recording.documents[index]?.body?.toString();

describe("recording a tab's answers", () => {
	test("gives each hop its answer, the document its body, and ignores the fragment the network never sees", () => {
		const recording = recordTab();
		recording.recordAnswer(answer("https://t.example/click", 1, undefined, 302));
		recording.recordAnswer(answer("https://kit.example/login", 2, "<html>login</html>"));
		recording.observe(shown("https://kit.example/login#victim@mail.com", [{ url: "https://t.example/click#victim@mail.com", status: 302 }]));

		expect(recording.documents[0]!.hops.map(({ receivedAt }) => receivedAt)).toEqual([answer("", 1).receivedAt, answer("", 2).receivedAt]);
		expect(bodyOf(recording, 0)).toBe("<html>login</html>");
	});

	test("a page reloading itself keeps every load's answer but bodies only up to the tab's bound", () => {
		const recording = recordTab();
		const fits = Math.floor(MAX_TAB_BODY_BYTES / MB);
		for (let load = 0; load < fits + 15; load++) {
			recording.recordAnswer(answer("https://kit.example/loop", load, Buffer.alloc(MB, load % 256)));
			recording.observe(shown("https://kit.example/loop"));
		}

		expect(recording.documents).toHaveLength(fits + 15);
		expect(recording.documents.every(({ hops }) => hops[0]!.receivedAt)).toBe(true);
		// Each load got its own answer, in order.
		expect(recording.documents.map(({ hops }) => hops[0]!.receivedAt)).toEqual(Array.from({ length: fits + 15 }, (_, load) => answer("", load).receivedAt));
		expect(recording.documents.slice(0, fits).every(({ body }, load) => body?.equals(Buffer.alloc(MB, load % 256)))).toBe(true);
		expect(recording.documents.slice(fits).some(({ body }) => body)).toBe(false);
	});

	test("a page of any status is a document of the tab, with its redirects and its body", () => {
		const recording = recordTab();
		for (const [position, status] of [500, 404, 403, 451].entries()) {
			const url = `https://kit.example/page-${status}`;
			recording.recordAnswer(answer("https://t.example/click", position * 10, undefined, 302));
			recording.recordAnswer(answer(url, position * 10 + 1, `lure ${status}`, status));
			recording.observe(shown(url, [{ url: "https://t.example/click", status: 302 }], status));
			expect(recording.documents[position]!.hops.map((hop) => hop.status)).toEqual([302, status]);
			expect(bodyOf(recording, position)).toBe(`lure ${status}`);
		}
	});

	test("the interstitials before a document that replaced them are forgotten, and nothing else", () => {
		const recording = recordTab();
		recording.recordAnswer(answer("https://kit.example/", 0, "Just a moment...", 403));
		recording.observe(shown("https://kit.example/", [], 403));
		recording.recordAnswer(answer("https://kit.example/", 1, "Just a moment...", 503));
		recording.observe(shown("https://kit.example/", [], 503));
		recording.recordAnswer(answer("https://kit.example/", 2, "real", 500));
		recording.observe(shown("https://kit.example/", [], 500));

		recording.discardBefore("https://kit.example/");

		expect(recording.documents.map((document) => document.hops.map((hop) => hop.status))).toEqual([[500]]);
		expect(bodyOf(recording, 0)).toBe("real");
		// The visitor's fragment on either address changes nothing: the network never sees it.
		recording.recordAnswer(answer("https://kit.example/next", 3, "next", 403));
		recording.observe(shown("https://kit.example/next", [], 403));
		recording.recordAnswer(answer("https://kit.example/next", 4, "real next", 200));
		recording.observe(shown("https://kit.example/next#victim@mail.com", [], 200));
		recording.discardBefore("https://kit.example/next#victim@mail.com");
		expect(recording.documents.map((document) => document.url)).toEqual(["https://kit.example/next#victim@mail.com"]);
		expect(bodyOf(recording, 0)).toBe("real next");
		// An address no document has, or the first document's own, changes nothing.
		recording.discardBefore("https://elsewhere.example/");
		recording.discardBefore("https://kit.example/next");
		expect(recording.documents).toHaveLength(1);
	});

	test("a page reloading itself into errors keeps no more than the bound of answers, the oldest let go", () => {
		for (const errors of [MAX_UNCLAIMED_ANSWERS - 1, MAX_UNCLAIMED_ANSWERS]) {
			const recording = recordTab();
			recording.recordAnswer(answer("https://kit.example/real", 0, "real"));
			for (let error = 1; error <= errors; error++) recording.recordAnswer(answer("https://kit.example/check", error, undefined, 503));
			recording.observe(shown("https://kit.example/real"));

			expect(bodyOf(recording, 0)).toBe(errors < MAX_UNCLAIMED_ANSWERS ? "real" : undefined);
		}
	});

	test("an answer older than the newest document's is let go: an abandoned load never lends its body to the address's next one", () => {
		const recording = recordTab();
		// The tab was sent to /a, then to /b before /a committed.
		recording.recordAnswer(answer("https://kit.example/a", 1, "abandoned"));
		recording.recordAnswer(answer("https://kit.example/b", 2, "b"));
		recording.observe(shown("https://kit.example/b"));
		recording.recordAnswer(answer("https://kit.example/a", 3, "shown"));
		recording.observe(shown("https://kit.example/a"));

		expect([bodyOf(recording, 0), bodyOf(recording, 1)]).toEqual(["b", "shown"]);
		expect(recording.documents[1]!.hops[0]!.receivedAt).toBe(answer("", 3).receivedAt);
	});

	test("an answer recorded after its document was shown still reaches it, before the next document lets older answers go", () => {
		const recording = recordTab();
		recording.observe(shown("https://kit.example/first"));
		recording.recordAnswer(answer("https://kit.example/first", 1, "first"));
		recording.recordAnswer(answer("https://kit.example/second", 2, "second"));
		recording.observe(shown("https://kit.example/second"));

		expect([bodyOf(recording, 0), bodyOf(recording, 1)]).toEqual(["first", "second"]);

		recording.observe(shown("https://kit.example/third"));
		recording.recordAnswer(answer("https://kit.example/third", 3, "third"));
		recording.settleAnswers();
		expect(bodyOf(recording, 2)).toBe("third");
	});

	test("the oldest unclaimed answers give up their bodies first when a new page needs the room", () => {
		const recording = recordTab();
		const fits = Math.floor(MAX_TAB_BODY_BYTES / MB);
		// Loads abandoned before they committed, never shown.
		for (let load = 0; load < fits; load++) recording.recordAnswer(answer(`https://kit.example/abandoned-${load}`, load, Buffer.alloc(MB)));
		recording.recordAnswer(answer("https://kit.example/page", fits, Buffer.alloc(MB, 1)));
		recording.observe(shown("https://kit.example/page"));

		expect(recording.documents[0]!.body?.equals(Buffer.alloc(MB, 1))).toBe(true);
	});

	test("a tab whose answers never arrive records its documents all the same", () => {
		const recording = recordTab();
		for (let load = 0; load < MAX_UNCLAIMED_ANSWERS * 3; load++) recording.observe(shown(`https://kit.example/${load}`, [{ url: `https://t.example/${load}`, status: 302 }]));
		recording.settleAnswers();

		expect(recording.documents).toHaveLength(MAX_UNCLAIMED_ANSWERS * 3);
		expect(recording.documents.some(({ hops, body }) => body || hops.some(({ receivedAt }) => receivedAt))).toBe(false);
	});
});
