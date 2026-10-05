import pfp from "@/assets/samuelscheit.jpg";
import Image from "next/image";
import Donate from "./Donate";

export default function About() {
	return (
		<div className="max-w-3xl space-y-8">
			<div className="space-y-3">
				<h2 className="text-3xl font-semibold">How to use it</h2>

				<div className="text-muted-foreground space-y-3">
					<p>Phishing Support helps you check and report suspicious emails or links.</p>

					<ol className="list-decimal pl-6 space-y-2">
						<li>
							<strong>Send an email</strong>
							<ul className="list-disc pl-6 space-y-1">
								<li>
									Forward the phishing email to{" "}
									<a href="mailto:report@phishing.support" className="text-blue-500">
										report@phishing.support
									</a>{" "}
									or
								</li>
								<li>Upload the email as an .eml (EML) file on the form above.</li>
							</ul>
						</li>

						<li>
							<strong>Report a suspicious link</strong>
							<ul className="list-disc pl-6 space-y-1">
								<li>Paste the website URL into the Website field and click Report.</li>
							</ul>
						</li>
					</ol>

					<h3 className="text-xl font-semibold">What happens next</h3>

					<p>Phishing Support will:</p>
					<ul className="list-disc pl-6 space-y-1">
						<li>Pull out the important clues (links, domains, sender info, technical headers)</li>
						<li>Do a quick automated check and label it (e.g. "likely phishing" or "probably safe")</li>
						<li>Try to report it to the right places (website host, domain registrar, takedown services)</li>
						<li>Save a record so you (or a security team) can review and follow up if needed</li>
					</ul>

					<p className="font-semibold">Privacy note</p>
					<p>Only submit emails or links you're allowed to share publicly.</p>
				</div>
			</div>

			<div className="space-y-3">
				<h2 className="text-3xl font-semibold">Who is behind this?</h2>
				<div className="text-muted-foreground space-y-4">
					<div className="flex items-start gap-4">
						<span className="float-left">
							<span className="mt-2">
								<Image
									src={pfp}
									alt="Samuel Scheit"
									width={128}
									height={128}
									className="rounded-full float-right inline mr-2 mb-2"
								/>
								<span>Hi, I'm Samuel 👋 and I like building things.</span>
								<br />
								Most of the time that means small open-source projects, often around data science, where I can learn
								something new and turn an idea into something practical. I keep a{" "}
								<a
									href="https://samuelscheit.com"
									target="_blank"
									rel="noreferrer"
									className="underline hover:text-primary inline-flex items-center gap-2"
								>
									website/blog
								</a>{" "}
								where I write about what I'm working on from time to time, and most of my projects live on{" "}
								<a
									href="https://github.com/samuelScheit"
									target="_blank"
									rel="noreferrer"
									className="underline hover:text-primary inline-flex items-center gap-2"
								>
									GitHub
								</a>
								. If you're curious, I also post irregular updates on{" "}
								<a
									href="https://x.com/SamuelScheit"
									target="_blank"
									rel="noreferrer"
									className="underline hover:text-primary inline-flex items-center gap-2"
								>
									Twitter
								</a>
								.
							</span>

							<p className="mt-2 select-none">
								If you want to reach out, you can email me at{" "}
								<a href="mailto:contact@samuelscheit.com" className="text-blue-500 select-all">
									contact@samuelscheit.com
								</a>
								.
							</p>
						</span>
					</div>
				</div>
			</div>

			<div className="space-y-3">
				<h2 className="text-3xl font-semibold">How it got started</h2>

				<pre className="text-muted-foreground whitespace-break-spaces font-sans text-justify">
					Phishing emails have been showing up in my inbox for years.
					<br />
					Annoying is one thing, but the part that really got old was how much busywork it takes to do something about them.
					<br />
					<br />
					Every time I wanted to report one properly, I'd end up repeating the same routine: dig through the headers, trace where
					it actually came from, figure out the hosting provider, and send an abuse report. If the email pointed to a phishing
					site, I'd do that whole process again for the website.
					<br />
					<br />
					Another day, another phishing email landed in my inbox and that was the moment that pushed me over the edge.
					<br />
					I thought: there has to be a better way. Why not automate this whole process?
					<br />
					<br />
					So I built Phishing Support, an application that automates the analysis and reporting of phishing emails and websites.
				</pre>
			</div>

			<Donate />

			{/* <p className="text-muted-foreground">
				The project is open source - you can review the code, run your own instance, or contribute improvements at{" "}
				<a
					href="https://github.com/samuelscheit/phishing_support"
					className="underline hover:text-primary"
					target="_blank"
					rel="noreferrer"
				>
					github.com/samuelscheit/phishing_support
				</a>
				.
			</p> */}
		</div>
	);
}
