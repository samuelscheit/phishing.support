"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { Link, Mail, Upload, Loader2 } from "lucide-react";

/** The report form; `defaultTab` opens it on the email or the website tab. */
export function SubmissionForm({ defaultTab = "email" }: { defaultTab?: "email" | "url" }) {
	const router = useRouter();
	const [url, setUrl] = useState("");
	const [file, setFile] = useState<File | null>(null);
	const [showWebsiteSnapshotInput, setShowWebsiteSnapshotInput] = useState(false);
	const [websiteSnapshotFile, setWebsiteSnapshotFile] = useState<File | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const email = "report@phishing.support";
	const websiteSnapshotInputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Shift" || e.repeat) return;

			const el = document.activeElement as HTMLElement | null;
			const tag = el?.tagName?.toLowerCase();
			const isTypingTarget = tag === "input" || tag === "textarea" || (el as any)?.isContentEditable;
			if (isTypingTarget) return;

			setShowWebsiteSnapshotInput((v) => !v);
		};

		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	useEffect(() => {
		if (!showWebsiteSnapshotInput) {
			setWebsiteSnapshotFile(null);
			return;
		}
		websiteSnapshotInputRef.current?.focus();
	}, [showWebsiteSnapshotInput]);

	const fileToDataUrl = (f: File) =>
		new Promise<string>((resolve, reject) => {
			const reader = new FileReader();
			reader.onerror = () => reject(new Error("Failed to read file"));
			reader.onload = () => resolve(String(reader.result || ""));
			reader.readAsDataURL(f);
		});

	const copyEmail = async () => {
		try {
			if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
				await navigator.clipboard.writeText(email);
			} else {
				const ta = document.createElement("textarea");
				ta.value = email;
				document.body.appendChild(ta);
				ta.select();
				document.execCommand("copy");
				ta.remove();
			}
		} catch (err) {
			console.error("copy failed", err);
		}
	};

	const handleUrlSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!url) return;

		setIsSubmitting(true);
		try {
			let mhtml_base64: string | undefined;
			if (showWebsiteSnapshotInput && websiteSnapshotFile) {
				const MAX_MHTML_BYTES = 25 * 1024 * 1024;
				if (websiteSnapshotFile.size > MAX_MHTML_BYTES) {
					throw new Error("MHTML snapshot too large");
				}
				mhtml_base64 = await fileToDataUrl(websiteSnapshotFile);
			}

			const res = await fetch("/api/submissions/website", {
				method: "POST",
				body: JSON.stringify({ url, mhtml_base64 }),
				headers: { "Content-Type": "application/json" },
			});
			const data = await res.json();
			if (data.stream_id) {
				router.push(`/submissions/${data.stream_id}`);
			}
		} catch (err) {
			console.error(err);
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleFileSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!file) return;

		setIsSubmitting(true);
		try {
			const formData = new FormData();
			formData.append("file", file);

			const res = await fetch("/api/submissions/email", {
				method: "POST",
				body: formData,
			});
			const data = await res.json();
			if (data.stream_id) {
				router.push(`/submissions/${data.stream_id}`);
			}
		} catch (err) {
			console.error(err);
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<Card className="w-full max-w-2xl mx-auto">
			<CardHeader>
				<CardTitle>Submit Phishing Threat</CardTitle>
				<CardDescription>Submit a suspicious website URL or email for analysis and to report it.</CardDescription>
			</CardHeader>
			<CardContent>
				<Tabs defaultValue={defaultTab} className="w-full">
					<TabsList className="grid w-full grid-cols-2">
						<TabsTrigger value="url">
							<Link className="w-4 h-4 mr-2" />
							Website URL
						</TabsTrigger>
						<TabsTrigger value="email">
							<Mail className="w-4 h-4 mr-2" />
							Phishing Email
						</TabsTrigger>
					</TabsList>
					<TabsContent value="url">
						<form onSubmit={handleUrlSubmit} className="space-y-4 pt-4">
							<div className="space-y-2">
								<Label htmlFor="url">Website URL</Label>
								<Input
									id="url"
									placeholder="https://suspicious-site.com/login"
									value={url}
									onChange={(e) => setUrl(e.target.value)}
									required
								/>
							</div>

							{showWebsiteSnapshotInput ? (
								<div className="space-y-2">
									<div className="flex items-center justify-between gap-2">
										<Label htmlFor="websiteSnapshot">Website snapshot (optional)</Label>
										<span className="text-xs text-muted-foreground">
											Press Shift to {showWebsiteSnapshotInput ? "hide" : "show"}
										</span>
									</div>
									<Input
										ref={websiteSnapshotInputRef}
										id="websiteSnapshot"
										type="file"
										accept=".mhtml,.mht"
										onChange={(e) => setWebsiteSnapshotFile(e.target.files?.[0] || null)}
									/>
									{websiteSnapshotFile ? (
										<p className="text-xs text-muted-foreground">Selected: {websiteSnapshotFile.name}</p>
									) : (
										<p className="text-xs text-muted-foreground">
											Upload an MHTML snapshot to analyze without loading the live site.
										</p>
									)}
								</div>
							) : undefined}
							<Button type="submit" className="w-full" disabled={isSubmitting}>
								{isSubmitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
								Report Website
							</Button>
						</form>
					</TabsContent>
					<TabsContent value="email">
						<form onSubmit={handleFileSubmit} className="space-y-4 pt-4">
							<div className="space-y-2">
								<Label htmlFor="file">Email File (.eml)</Label>
								<div className="flex items-center justify-center w-full">
									<label
										htmlFor="file"
										className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed rounded-lg cursor-pointer bg-muted/50 hover:bg-muted"
									>
										<div className="flex flex-col items-center justify-center pt-5 pb-6">
											<Upload className="w-8 h-8 mb-2 text-muted-foreground" />
											<p className="mb-2 text-sm text-muted-foreground">
												<span className="font-semibold">Click to upload</span> or drag and drop
											</p>
											<p className="text-xs text-muted-foreground">EML files only</p>
										</div>
										<Input
											id="file"
											type="file"
											className="hidden"
											accept=".eml"
											onChange={(e) => setFile(e.target.files?.[0] || null)}
										/>
									</label>
								</div>
								{file && <p className="text-sm text-muted-foreground mt-2">Selected: {file.name}</p>}
							</div>
							<Button type="submit" className="w-full" disabled={isSubmitting || !file}>
								{isSubmitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
								Report Email
							</Button>
						</form>

						{/* Notice: forwarding instructions for users who prefer email forwarding */}
						<div className="mt-6 flex justify-center">
							{/* Prominent clickable email block - copies address on click */}
							<div
								role="button"
								tabIndex={0}
								onKeyDown={(e: React.KeyboardEvent) => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										copyEmail();
									}
								}}
								className={`cursor-pointer w-full px-6 py-4 rounded-lg shadow-sm border transition-colors bg-blue-50 text-center text-blue-800 border-blue-200 hover:bg-blue-100`}
								onClick={() => copyEmail()}
							>
								<p className={`text-sm text-blue-900 font-medium select-none"}`}>
									You can also forward phishing emails directly to:
								</p>
								<p className={`select-all mt-1 text-lg sm:text-xl font-semibold text-blue-900`}>report@phishing.support</p>
								<p className={`text-sm mt-1 text-blue-800 select-none"}`}>
									Right click on the original mail and choose "Forward as Attachment" (.eml) for best results.
								</p>
							</div>
						</div>
					</TabsContent>
				</Tabs>
			</CardContent>
		</Card>
	);
}
