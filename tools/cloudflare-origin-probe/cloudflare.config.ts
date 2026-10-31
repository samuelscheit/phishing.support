import { bindings, defineConfig } from "cf/config";

import * as entrypoint from "./worker.js" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "origin-probe293",
		entrypoint,
		compatibilityDate: "2026-10-31",
		previewUrls: false,
		env: {
			PROBE_TOKEN: bindings.secret(),
		},
	},
});
