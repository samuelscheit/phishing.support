import { ArtifactsEntity } from "../db/entities";
import { reportTencentCloudAbuse } from "./tencentCloudAbuse";

const artifact = await ArtifactsEntity.get(268771696171814913n);
if (!artifact) throw new Error("Artifact not found");

await reportTencentCloudAbuse({
	analysisText: "test",
	explanation: `The website https://saewar.com/De56Mgw1A is a phishing/credential-harvesting page impersonating Trade Republic (Trade Republic Bank GmbH). It presents a fake Trade Republic login flow in German and attempts to collect a user’s phone number and 4‑digit PIN—credentials Trade Republic explicitly states it will never ask for via such pages. The domain saewar.com is not an official Trade Republic domain, was newly registered (2026-01-08) on your registrar platform.`,
	submissionId: 268774127068778496n,
	url: "https://saewar.com/De56Mgw1A",
	infringedUrl: "https://app.traderepublic.com/login",
	websiteScreenshot: artifact.blob,
}).catch(console.log);
