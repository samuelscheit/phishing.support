import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ImageResponse } from "next/og";

/** Share cards are 1200×630, the size every network crops to. */
export const SHARE_CARD_SIZE = { width: 1200, height: 630 };

const TONES = {
	danger: { badge: "#dc2626", text: "#ffffff" },
	safe: { badge: "#059669", text: "#ffffff" },
	pending: { badge: "#2563eb", text: "#ffffff" },
	neutral: { badge: "#52525b", text: "#ffffff" },
} as const;

let assets: { shield: string; regular: Buffer; bold: Buffer } | undefined;

/** The site's shield icon as a data URL, and Geist in both weights the card uses (next/og bundles only the regular one); read once. */
function shareCardAssets() {
	assets ??= {
		shield: `data:image/svg+xml;base64,${readFileSync(join(process.cwd(), "src/app/icon.svg")).toString("base64")}`,
		regular: readFileSync(join(process.cwd(), "node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf")),
		bold: readFileSync(join(process.cwd(), "src/assets/fonts/Geist-Bold.ttf")),
	};
	return assets;
}

/**
 * A share card: the site's name, a headline, and an optional verdict badge.
 * Long headlines shrink so they never overflow the card.
 */
export function shareCard(params: { eyebrow: string; headline: string; badge?: { label: string; tone: keyof typeof TONES } }): ImageResponse {
	const { eyebrow, headline, badge } = params;
	const fontSize = headline.length > 60 ? 52 : headline.length > 32 ? 64 : 80;
	const { shield, regular, bold } = shareCardAssets();
	return new ImageResponse(
		(
			<div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 72, background: "linear-gradient(135deg, #ffffff 0%, #eef2ff 100%)", fontFamily: "Geist" }}>
				<div style={{ display: "flex", alignItems: "center", gap: 20 }}>
					{/* eslint-disable-next-line @next/next/no-img-element -- the share card is rendered by Satori, not the browser */}
					<img src={shield} width={64} height={64} alt="" />
					<div style={{ fontSize: 40, fontWeight: 700, color: "#111827" }}>Phishing Support</div>
				</div>
				<div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
					<div style={{ fontSize: 30, fontWeight: 400, color: "#4b5563" }}>{eyebrow}</div>
					<div style={{ fontSize, fontWeight: 700, color: "#111827", lineHeight: 1.1, letterSpacing: -1, wordBreak: "break-word" }}>{headline}</div>
				</div>
				<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
					{badge ? (
						<div style={{ display: "flex", padding: "14px 28px", borderRadius: 999, background: TONES[badge.tone].badge, color: TONES[badge.tone].text, fontSize: 34, fontWeight: 700 }}>{badge.label}</div>
					) : (
						<div style={{ display: "flex" }} />
					)}
					<div style={{ fontSize: 28, color: "#4174f2", fontWeight: 600 }}>phishing.support</div>
				</div>
			</div>
		),
		{
			...SHARE_CARD_SIZE,
			fonts: [
				{ name: "Geist", data: regular, weight: 400, style: "normal" },
				{ name: "Geist", data: bold, weight: 700, style: "normal" },
			],
		},
	);
}
