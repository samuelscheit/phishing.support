/**
 * The languages the public visitor pages speak, and which one a request gets:
 * an explicit `?lang=` first (links and the switch), then the `lang` cookie
 * the switch leaves, then the browser's Accept-Language, then English.
 */
export const LOCALES = ["en", "de"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "lang";

export function isLocale(value: unknown): value is Locale {
	return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** The supported language the Accept-Language header prefers most, by its q-values. */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale | undefined {
	if (!header) return undefined;
	const ranked = header
		.split(",")
		.map((part, index) => {
			const [tag = "", ...params] = part.trim().split(";");
			const q = params.map((param) => param.trim()).find((param) => param.startsWith("q="));
			const quality = q ? Number(q.slice(2)) : 1;
			return { language: tag.trim().toLowerCase().split("-")[0], quality: Number.isFinite(quality) ? quality : 0, index };
		})
		.filter((entry) => entry.quality > 0)
		.sort((a, b) => b.quality - a.quality || a.index - b.index);
	return ranked.map((entry) => entry.language).find(isLocale);
}

export function pickLocale(source: { query?: unknown; cookie?: string | null; acceptLanguage?: string | null }): Locale {
	if (isLocale(source.query)) return source.query;
	if (isLocale(source.cookie)) return source.cookie;
	return localeFromAcceptLanguage(source.acceptLanguage) ?? DEFAULT_LOCALE;
}

/** BCP 47 tag for dates and numbers in a locale. */
export function intlTag(locale: Locale): string {
	return locale === "de" ? "de-DE" : "en-GB";
}

/**
 * A calendar date as "19 Nov 2026" / "19. Nov. 2026", in UTC so the server's
 * render and the browser's hydration always agree, whatever the viewer's zone.
 */
export function formatDate(time: string | number, locale: Locale): string {
	return new Date(time).toLocaleDateString(intlTag(locale), { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
