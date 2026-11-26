import { notFound } from "next/navigation";

import { LiveConsoleFixture } from "./LiveConsoleFixture";

export const metadata = { robots: { index: false } };

/**
 * The live console in each state, without a live visit: for screenshots
 * while working on it. Development only; production answers 404.
 * `?state=agent|pausing|you|other|ended|inline&frame=desktop|phone&theme=light|dark`
 */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
	if (process.env.NODE_ENV === "production") notFound();
	const params = await searchParams;
	const one = (key: string) => (typeof params[key] === "string" ? params[key] : undefined);
	return <LiveConsoleFixture state={one("state") ?? "agent"} frame={one("frame") === "phone" ? "phone" : "desktop"} theme={one("theme") === "dark" ? "dark" : "light"} />;
}
