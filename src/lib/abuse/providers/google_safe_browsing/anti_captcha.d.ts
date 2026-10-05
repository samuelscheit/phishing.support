declare module "@antiadmin/anticaptchaofficial" {
	const anticaptcha: {
		setAPIKey(key: string): void;
		solveRecaptchaV3(websiteUrl: string, websiteKey: string, minimumScore: number, pageAction: string): Promise<string>;
	};

	export default anticaptcha;
}
