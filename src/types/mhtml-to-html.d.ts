/**
 * mhtml-to-html ships its types (lib/mod.d.ts), but its package.json
 * "exports" map hides them from TypeScript's resolution: re-export them.
 */
declare module "mhtml-to-html" {
	type Library = typeof import("../../node_modules/mhtml-to-html/lib/mod");
	export const convert: Library["convert"];
	export const parse: Library["parse"];
}
