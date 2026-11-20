"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { LOCALE_COOKIE, LOCALES, type Locale } from "@/lib/i18n/locale";
import { cn } from "@/lib/util/cn";

const LABEL: Record<Locale, string> = { en: "English", de: "Deutsch" };

/**
 * Switches the visitor pages' language: remembers the choice in a cookie for
 * later visits and puts it in the address, so a shared link keeps it. The
 * `#host` that names the visitor's site stays.
 */
export function LanguageSwitch({ locale, className }: { locale: Locale; className?: string }) {
	const router = useRouter();
	const pathname = usePathname();
	const params = useSearchParams();
	const choose = (next: Locale) => {
		document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
		const search = new URLSearchParams(params);
		search.set("lang", next);
		router.replace(`${pathname}?${search}${window.location.hash}`, { scroll: false });
	};
	return (
		<nav aria-label="Language" className={cn("inline-flex shrink-0 whitespace-nowrap rounded-lg bg-muted p-0.5 text-sm", className)}>
			{LOCALES.map((code) => (
				<button
					key={code}
					type="button"
					lang={code}
					aria-current={code === locale ? "true" : undefined}
					onClick={() => choose(code)}
					className={cn("rounded-md px-2.5 py-1", code === locale ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground")}
				>
					{LABEL[code]}
				</button>
			))}
		</nav>
	);
}
