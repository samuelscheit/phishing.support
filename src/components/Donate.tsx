type DonateLinks = {
	patreon?: string;
	paypal?: string;
	githubSponsors?: string;
};

const LINKS: DonateLinks = {
	patreon: "https://www.patreon.com/YOUR_ACCOUNT",
	paypal: "https://www.paypal.me/YOUR_ACCOUNT",
	githubSponsors: "https://github.com/sponsors/samuelscheit",
};

export default function Donate() {
	return (
		<div className="max-w-3xl space-y-4">
			<h2 className="text-3xl font-semibold">Support the project</h2>

			<p className="text-muted-foreground">
				This project is free and open source, but running automated analysis and AI-powered classification has costs (API calls,
				compute, hosting). If you find this useful, a small donation helps keep the service online and helps fight phishing.
			</p>

			<div className="flex gap-3 justify-between">
				<div className="flex flex-row gap-3">
					{LINKS.patreon && (
						<a href={LINKS.patreon} className="underline" target="_blank" rel="noreferrer">
							Patreon
						</a>
					)}
					{LINKS.paypal && (
						<a href={LINKS.paypal} className="underline" target="_blank" rel="noreferrer">
							PayPal
						</a>
					)}
					{LINKS.githubSponsors && (
						<a href={LINKS.githubSponsors} className="underline" target="_blank" rel="noreferrer">
							GitHub Sponsors
						</a>
					)}
				</div>

				<a href="https://github.com/samuelscheit/phishing_support" className="underline ml-4" target="_blank" rel="noreferrer">
					View source
				</a>
			</div>

			<p className="text-xs text-muted-foreground">
				Thank you, every bit helps! Donations fund hosting, monitoring, and model/API costs.
			</p>
		</div>
	);
}
