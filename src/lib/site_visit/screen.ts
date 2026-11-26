import type { CDPSession, Page } from "rebrowser-puppeteer-core";

/**
 * The live screen of a visit: one screencast of the tab the visitor is on,
 * shared by everyone watching. It is small while people only glance at it,
 * and sharp and fluid while someone watches it full screen or drives the
 * browser. Frames are never stored: a viewer gets the newest one when it
 * starts watching and then each new one, at most as often as it asked for.
 */

/** One frame: a base64 JPEG and the page's CSS size it shows, which input coordinates are in. */
export type LiveFrame = { jpeg: string; url: string; width: number; height: number };

export type ScreenQuality = "low" | "high";

const QUALITY: Record<ScreenQuality, { fps: number; screencast: { quality: number; maxWidth: number; maxHeight: number; everyNthFrame: number } }> = {
	low: { fps: 3, screencast: { quality: 55, maxWidth: 960, maxHeight: 720, everyNthFrame: 2 } },
	high: { fps: 15, screencast: { quality: 80, maxWidth: 1920, maxHeight: 2560, everyNthFrame: 1 } },
};

/** A viewer, and the newest frame it skipped for its rate: a page that then stays still still reaches it. */
type Viewer = { show: (frame: LiveFrame) => void; quality: ScreenQuality; lastAt: number; skipped?: LiveFrame; timer?: ReturnType<typeof setTimeout> };

function deliver(viewer: Viewer, frame: LiveFrame): void {
	viewer.lastAt = Date.now();
	viewer.skipped = undefined;
	viewer.show(frame);
}
type ScreenTab = { session: CDPSession; page: Page };
type Running = { tab: ScreenTab; quality: ScreenQuality; stop: () => Promise<void> };
type ScreencastFrame = { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } };

export class LiveScreen {
	readonly #viewers = new Set<Viewer>();
	#tab?: ScreenTab;
	#driving = false;
	#running?: Running;
	#latest?: LiveFrame;
	/** Screencast changes run one at a time, in order. */
	#changes: Promise<void> = Promise.resolve();
	#closed = false;
	readonly #ended = Promise.withResolvers<void>();
	/** Resolves once the visit ended and no more frames come. */
	readonly ended = this.#ended.promise;

	/** Watch the screen until the returned function is called; nothing to watch once it closed. */
	watch(show: (frame: LiveFrame) => void, quality: ScreenQuality): () => void {
		if (this.#closed) return () => undefined;
		const viewer: Viewer = { show, quality, lastAt: 0 };
		this.#viewers.add(viewer);
		if (this.#latest) show(this.#latest);
		this.#reconcile();
		return () => {
			clearTimeout(viewer.timer);
			this.#viewers.delete(viewer);
			this.#reconcile();
		};
	}

	/** Show this tab from now on; also starts again a screencast the tab refused before. */
	show(tab: ScreenTab): Promise<void> {
		if (this.#tab?.session === tab.session && (this.#running || !this.#viewers.size)) return this.#changes;
		this.#tab = tab;
		return this.#reconcile();
	}

	/** A person drives the browser: the screen is sharp and fluid for everyone meanwhile. */
	setDriving(driving: boolean): void {
		this.#driving = driving;
		void this.#reconcile();
	}

	get viewers(): number {
		return this.#viewers.size;
	}

	async close(): Promise<void> {
		this.#closed = true;
		for (const viewer of this.#viewers) clearTimeout(viewer.timer);
		this.#viewers.clear();
		this.#latest = undefined;
		this.#ended.resolve();
		await this.#reconcile();
	}

	#wanted(): { tab: ScreenTab; quality: ScreenQuality } | undefined {
		if (this.#closed || !this.#tab || !this.#viewers.size) return undefined;
		const high = this.#driving || [...this.#viewers].some((viewer) => viewer.quality === "high");
		return { tab: this.#tab, quality: high ? "high" : "low" };
	}

	#reconcile(): Promise<void> {
		this.#changes = this.#changes.then(async () => {
			const wanted = this.#wanted();
			const running = this.#running;
			if (running && wanted && running.tab === wanted.tab && running.quality === wanted.quality) return;
			if (running) {
				this.#running = undefined;
				await running.stop();
			}
			if (wanted) this.#running = await this.#start(wanted.tab, wanted.quality).catch(() => undefined);
		});
		return this.#changes;
	}

	async #start(tab: ScreenTab, quality: ScreenQuality): Promise<Running> {
		const { session, page } = tab;
		const onFrame = (frame: ScreencastFrame) => {
			void session.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => undefined);
			const shown: LiveFrame = { jpeg: frame.data, url: page.url(), width: Math.round(frame.metadata.deviceWidth), height: Math.round(frame.metadata.deviceHeight) };
			this.#latest = shown;
			const now = Date.now();
			for (const viewer of this.#viewers) {
				const wait = viewer.lastAt + 1_000 / QUALITY[viewer.quality].fps - now;
				if (wait <= 0) {
					deliver(viewer, shown);
					continue;
				}
				viewer.skipped = shown;
				viewer.timer ??= setTimeout(() => {
					viewer.timer = undefined;
					if (viewer.skipped && this.#viewers.has(viewer)) deliver(viewer, viewer.skipped);
				}, wait);
			}
		};
		session.on("Page.screencastFrame", onFrame);
		try {
			await session.send("Page.startScreencast", { format: "jpeg", ...QUALITY[quality].screencast });
		} catch (error) {
			session.off("Page.screencastFrame", onFrame);
			throw error;
		}
		return {
			tab,
			quality,
			stop: async () => {
				session.off("Page.screencastFrame", onFrame);
				await session.send("Page.stopScreencast").catch(() => undefined);
			},
		};
	}
}
