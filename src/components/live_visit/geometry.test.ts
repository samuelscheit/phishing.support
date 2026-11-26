import { describe, expect, test } from "bun:test";

import { contentBox, pageScale, toPagePoint, wheelPixels } from "./geometry";

const box = { left: 100, top: 50, width: 1000, height: 500 };

describe("contentBox", () => {
	test("a frame of the box's shape fills it", () => {
		expect(contentBox(box, { width: 2000, height: 1000 })).toEqual(box);
	});

	test("a tall frame (a phone) leaves bars left and right", () => {
		expect(contentBox(box, { width: 400, height: 800 })).toEqual({ left: 475, top: 50, width: 250, height: 500 });
	});

	test("a wide frame leaves bars above and below", () => {
		expect(contentBox(box, { width: 2000, height: 500 })).toEqual({ left: 100, top: 175, width: 1000, height: 250 });
	});

	test("an empty box or frame covers nothing", () => {
		expect(contentBox({ ...box, width: 0 }, { width: 10, height: 10 }).width).toBe(0);
		expect(contentBox(box, { width: 0, height: 10 }).height).toBe(0);
	});
});

describe("toPagePoint", () => {
	const phone = { width: 400, height: 800 };
	const wide = { width: 2000, height: 500 };

	test("maps the corners and centre of a letterboxed phone frame", () => {
		expect(toPagePoint({ x: 475, y: 50 }, box, phone)).toEqual({ x: 0, y: 0 });
		expect(toPagePoint({ x: 725, y: 550 }, box, phone)).toEqual({ x: 400, y: 800 });
		expect(toPagePoint({ x: 600, y: 300 }, box, phone)).toEqual({ x: 200, y: 400 });
	});

	test("maps through bars above and below", () => {
		expect(toPagePoint({ x: 600, y: 300 }, box, wide)).toEqual({ x: 1000, y: 250 });
		expect(toPagePoint({ x: 100, y: 175 }, box, wide)).toEqual({ x: 0, y: 0 });
	});

	test("ignores clicks on the bars and outside the box", () => {
		expect(toPagePoint({ x: 474, y: 300 }, box, phone)).toBeUndefined();
		expect(toPagePoint({ x: 726, y: 300 }, box, phone)).toBeUndefined();
		expect(toPagePoint({ x: 600, y: 174 }, box, wide)).toBeUndefined();
		expect(toPagePoint({ x: 600, y: 426 }, box, wide)).toBeUndefined();
		expect(toPagePoint({ x: 0, y: 0 }, box, phone)).toBeUndefined();
	});

	test("clamps to the nearest edge for a drag that left the screen", () => {
		expect(toPagePoint({ x: 0, y: 1000 }, box, phone, { clamp: true })).toEqual({ x: 0, y: 800 });
		expect(toPagePoint({ x: 2000, y: -5 }, box, wide, { clamp: true })).toEqual({ x: 2000, y: 0 });
	});

	test("rounds to hundredths of a CSS pixel", () => {
		expect(toPagePoint({ x: 100.333, y: 50 }, box, { width: 3000, height: 1500 })).toEqual({ x: 1, y: 0 });
	});

	test("no frame size maps nothing", () => {
		expect(toPagePoint({ x: 600, y: 300 }, box, { width: 0, height: 0 })).toBeUndefined();
	});
});

describe("pageScale", () => {
	test("page pixels per shown pixel", () => {
		expect(pageScale(box, { width: 400, height: 800 })).toBe(1.6);
		expect(pageScale(box, { width: 500, height: 250 })).toBe(0.5);
		expect(pageScale({ ...box, width: 0 }, { width: 400, height: 800 })).toBe(1);
	});
});

describe("wheelPixels", () => {
	const page = { width: 1280, height: 720 };
	test("pixels stay pixels, lines and pages convert", () => {
		expect(wheelPixels({ deltaX: 3, deltaY: -120, deltaMode: 0 }, page)).toEqual({ deltaX: 3, deltaY: -120 });
		expect(wheelPixels({ deltaX: 0, deltaY: 3, deltaMode: 1 }, page)).toEqual({ deltaX: 0, deltaY: 120 });
		expect(wheelPixels({ deltaX: 1, deltaY: -1, deltaMode: 2 }, page)).toEqual({ deltaX: 1280, deltaY: -720 });
	});
});
