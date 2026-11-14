import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "@/lib/seo/site";

const geistSans = Geist({
	variable: "--font-geist-sans",
	subsets: ["latin"],
});

const geistMono = Geist_Mono({
	variable: "--font-geist-mono",
	subsets: ["latin"],
});

export const metadata: Metadata = {
	metadataBase: new URL(SITE_URL),
	title: { default: SITE_NAME, template: `%s · ${SITE_NAME}` },
	description: SITE_DESCRIPTION,
	applicationName: SITE_NAME,
	openGraph: { type: "website", siteName: SITE_NAME, locale: "en_US" },
	twitter: { card: "summary_large_image", creator: "@SamuelScheit" },
};

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html lang="en">
			<body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
				{children}

				<script async src="https://p.samuelscheit.com/js/pa-25BABMWufuiHdv_puxmeh.js"></script>
				<script
					dangerouslySetInnerHTML={{
						__html: `window.plausible=window.plausible||function(){(plausible.q = plausible.q || []).push(arguments)}
					,plausible.init=plausible.init||function(i){(plausible.o = i || {})}; plausible.init()`,
					}}
				></script>
			</body>
		</html>
	);
}
