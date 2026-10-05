"use client";

import Link from "next/link";
import { FormEvent, useMemo, useState } from "react";

type EvidenceItem = {
	filename: string;
	mimeType: string;
	base64: string;
};

const MAX_FILES = 15;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

function fileToBase64(file: File): Promise<string> {
	return file.arrayBuffer().then((arrayBuffer) => {
		const bytes = new Uint8Array(arrayBuffer);
		let binary = "";
		const chunkSize = 0x8000;
		for (let offset = 0; offset < bytes.length; offset += chunkSize) {
			binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
		}
		return btoa(binary);
	});
}

function parseObservedUrls(value: string, targets: string[]): Array<{ target: string; urls: string[] }> {
	const byTarget = new Map<string, string[]>();
	for (const line of value
		.split(/\r?\n/)
		.map((item) => item.trim())
		.filter(Boolean)) {
		const separator = line.indexOf("|");
		if (separator < 1) throw new Error("Observed URLs must use one `target | URL` entry per line.");
		const target = line.slice(0, separator).trim();
		const url = line.slice(separator + 1).trim();
		if (!url) throw new Error("Every observed-URL entry needs a URL.");
		if (!targets.some((candidate) => candidate.trim().toLowerCase() === target.toLowerCase())) {
			throw new Error(`Observed URL target “${target}” is not listed above.`);
		}
		const urls = byTarget.get(target) ?? [];
		if (!urls.includes(url)) urls.push(url);
		byTarget.set(target, urls);
	}
	return [...byTarget.entries()].map(([target, urls]) => ({ target, urls }));
}

export function AbuseReportForm() {
	const [targets, setTargets] = useState("");
	const [category, setCategory] = useState("phishing");
	const [description, setDescription] = useState("");
	const [observedUrls, setObservedUrls] = useState("");
	const [legalBrandUrl, setLegalBrandUrl] = useState("");
	const [reporterEmail, setReporterEmail] = useState("");
	const [reporterIdentity, setReporterIdentity] = useState<"service" | "submitter">("service");
	const [files, setFiles] = useState<EvidenceItem[]>([]);
	const [error, setError] = useState<string>();
	const [submittedUrl, setSubmittedUrl] = useState<string>();
	const [submitting, setSubmitting] = useState(false);

	const targetList = useMemo(
		() =>
			targets
				.split(/\r?\n|,/)
				.map((item) => item.trim())
				.filter(Boolean),
		[targets],
	);

	async function onFilesChanged(event: React.ChangeEvent<HTMLInputElement>) {
		setError(undefined);
		const selected = [...(event.target.files ?? [])];
		if (selected.length > MAX_FILES) {
			setError(`Please choose no more than ${MAX_FILES} evidence images.`);
			return;
		}
		if (selected.some((file) => !["image/jpeg", "image/png", "image/webp"].includes(file.type))) {
			setError("Evidence must be a JPEG, PNG, or WebP image.");
			return;
		}
		if (selected.some((file) => file.size > MAX_FILE_BYTES)) {
			setError("Each evidence image must be 5 MB or smaller.");
			return;
		}
		if (selected.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_BYTES) {
			setError("Evidence is limited to 20 MB per report.");
			return;
		}
		try {
			const encoded = await Promise.all(
				selected.map(async (file) => ({ filename: file.name, mimeType: file.type, base64: await fileToBase64(file) })),
			);
			setFiles(encoded);
		} catch {
			setError("The selected evidence could not be read.");
		}
	}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setError(undefined);
		setSubmittedUrl(undefined);
		if (targetList.length === 0) {
			setError("Add at least one domain or public IP address.");
			return;
		}
		if (!description.trim()) {
			setError("Describe what makes the target abusive.");
			return;
		}
		setSubmitting(true);
		try {
			const payload = {
				targets: targetList,
				allegationCategory: category,
				description: description.trim(),
				observedUrls: observedUrls.trim() ? parseObservedUrls(observedUrls, targetList) : undefined,
				legalBrandUrl: legalBrandUrl.trim() || undefined,
				reporterContactEmail: reporterEmail.trim() || undefined,
				reporterIdentity,
				evidence: files.length ? files : undefined,
			};
			const response = await fetch("/api/abuse/reports", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			const result = (await response.json().catch(() => ({}))) as { statusUrl?: string; error?: string };
			if (!response.ok || !result.statusUrl) throw new Error(result.error || "The report could not be accepted.");
			setSubmittedUrl(result.statusUrl);
		} catch (submissionError) {
			setError(submissionError instanceof Error ? submissionError.message : "The report could not be accepted.");
		} finally {
			setSubmitting(false);
		}
	}

	if (submittedUrl) {
		return (
			<section aria-live="polite" className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-emerald-950 shadow-sm">
				<h2 className="text-2xl font-semibold">Report accepted</h2>
				<p className="mt-2">Your report is queued for independent resolution and automated provider submission.</p>
				<p className="mt-4 text-sm">Keep this private status link. It is the only way to view progress.</p>
				<Link
					className="mt-4 inline-flex rounded-lg bg-emerald-800 px-4 py-2 font-medium text-white hover:bg-emerald-900"
					href={submittedUrl}
				>
					View report status
				</Link>
			</section>
		);
	}

	return (
		<form onSubmit={submit} className="space-y-8" noValidate>
			<div className="rounded-2xl border bg-card p-6 shadow-sm">
				<div className="space-y-2">
					<label htmlFor="abuse-targets" className="text-sm font-semibold">
						Domains or public IP addresses
					</label>
					<textarea
						id="abuse-targets"
						value={targets}
						onChange={(event) => setTargets(event.target.value)}
						rows={4}
						required
						placeholder="example.com\n1.1.1.1"
						className="w-full rounded-lg border bg-background p-3 font-mono text-sm"
					/>
					<p className="text-xs text-muted-foreground">
						One target per line. Private, loopback, documentation, and non-routable IP ranges are rejected.
					</p>
				</div>

				<div className="mt-6 space-y-2">
					<label htmlFor="abuse-category" className="text-sm font-semibold">
						Allegation category
					</label>
					<select
						id="abuse-category"
						value={category}
						onChange={(event) => setCategory(event.target.value)}
						className="w-full rounded-lg border bg-background p-3"
					>
						<option value="phishing">Phishing</option>
						<option value="fraud">Fraud</option>
						<option value="malware">Malware</option>
						<option value="impersonation">Impersonation</option>
						<option value="copyright">Copyright</option>
						<option value="other">Other abuse</option>
					</select>
				</div>

				<div className="mt-6 space-y-2">
					<label htmlFor="abuse-description" className="text-sm font-semibold">
						What happened?
					</label>
					<textarea
						id="abuse-description"
						value={description}
						onChange={(event) => setDescription(event.target.value)}
						rows={8}
						required
						maxLength={30000}
						placeholder="Describe the allegation, the impersonated service, and any useful context."
						className="w-full rounded-lg border bg-background p-3"
					/>
					<p className="text-xs text-muted-foreground">
						The complete narrative is retained. Provider-specific summaries are generated separately.
					</p>
				</div>
			</div>

			<div className="rounded-2xl border bg-card p-6 shadow-sm">
				<h2 className="text-lg font-semibold">Evidence and context</h2>
				<div className="mt-4 space-y-2">
					<label htmlFor="abuse-observed-urls" className="text-sm font-semibold">
						Observed URLs (optional)
					</label>
					<textarea
						id="abuse-observed-urls"
						value={observedUrls}
						onChange={(event) => setObservedUrls(event.target.value)}
						rows={5}
						placeholder="example.com | https://example.com/login"
						className="w-full rounded-lg border bg-background p-3 font-mono text-sm"
					/>
					<p className="text-xs text-muted-foreground">
						Use one <code>target | URL</code> entry per line. URLs must be HTTP(S) and belong to the submitted domain.
					</p>
				</div>

				<div className="mt-6 space-y-2">
					<label htmlFor="abuse-brand-url" className="text-sm font-semibold">
						Legal brand URL (optional unless a provider requires it)
					</label>
					<input
						id="abuse-brand-url"
						type="url"
						value={legalBrandUrl}
						onChange={(event) => setLegalBrandUrl(event.target.value)}
						placeholder="https://your-official-brand.example"
						className="w-full rounded-lg border bg-background p-3"
					/>
				</div>

				<div className="mt-6 space-y-2">
					<label htmlFor="abuse-evidence" className="text-sm font-semibold">
						Screenshots
					</label>
					<input
						id="abuse-evidence"
						type="file"
						accept="image/jpeg,image/png,image/webp"
						multiple
						onChange={onFilesChanged}
						className="block w-full rounded-lg border bg-background p-3 text-sm"
					/>
					<p className="text-xs text-muted-foreground">
						Up to 15 images, 5 MB each, 20 MB total. Originals are retained and provider derivatives are generated server-side.
					</p>
					{files.length > 0 && (
						<p className="text-sm text-muted-foreground" aria-live="polite">
							{files.length} image{files.length === 1 ? "" : "s"} ready.
						</p>
					)}
				</div>
			</div>

			<div className="rounded-2xl border bg-card p-6 shadow-sm">
				<h2 className="text-lg font-semibold">Reporter contact (optional)</h2>
				<div className="mt-4 space-y-2">
					<label htmlFor="abuse-email" className="text-sm font-semibold">
						Email address
					</label>
					<input
						id="abuse-email"
						type="email"
						value={reporterEmail}
						onChange={(event) => setReporterEmail(event.target.value)}
						placeholder="you@example.org"
						className="w-full rounded-lg border bg-background p-3"
					/>
				</div>
				<fieldset className="mt-5">
					<legend className="text-sm font-semibold">External identity preference</legend>
					<div className="mt-3 flex flex-wrap gap-4">
						<label className="inline-flex items-center gap-2">
							<input
								type="radio"
								name="reporter-identity"
								value="service"
								checked={reporterIdentity === "service"}
								onChange={() => setReporterIdentity("service")}
							/>{" "}
							Phishing Support
						</label>
						<label className="inline-flex items-center gap-2">
							<input
								type="radio"
								name="reporter-identity"
								value="submitter"
								checked={reporterIdentity === "submitter"}
								onChange={() => setReporterIdentity("submitter")}
							/>{" "}
							My identity, when a route permits it
						</label>
					</div>
				</fieldset>
			</div>

			{error && (
				<p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900">
					{error}
				</p>
			)}
			<button
				type="submit"
				disabled={submitting}
				className="w-full rounded-xl bg-primary px-5 py-3 font-semibold text-primary-foreground shadow-sm hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
			>
				{submitting ? "Accepting report…" : "Submit abuse report"}
			</button>
		</form>
	);
}
