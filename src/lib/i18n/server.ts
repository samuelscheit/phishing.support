import { cookies, headers } from "next/headers";

import { LOCALE_COOKIE, pickLocale, type Locale } from "./locale";

/** The language of the current request, for a server component that got its `?lang=` from searchParams. */
export async function requestLocale(query?: unknown): Promise<Locale> {
	const [cookieStore, headerList] = await Promise.all([cookies(), headers()]);
	return pickLocale({ query, cookie: cookieStore.get(LOCALE_COOKIE)?.value, acceptLanguage: headerList.get("accept-language") });
}
