/**
 * Scroll the nearest scrolling box around `element` to its end, the way a
 * live log follows its newest line. Unlike `scrollIntoView`, the page itself
 * never moves: a finished case opened from the list stays at its top.
 */
export function scrollToEnd(element: Element | null | undefined): void {
	for (let box = element?.parentElement; box && box !== document.body && box !== document.documentElement; box = box.parentElement) {
		const { overflowY } = getComputedStyle(box);
		if ((overflowY === "auto" || overflowY === "scroll") && box.scrollHeight > box.clientHeight) {
			box.scrollTop = box.scrollHeight;
			return;
		}
	}
}
