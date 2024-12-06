import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import dotenv from "dotenv";
import path from "path";

// Load environment variables from .env file
dotenv.config();

const banner = `/*
THIS IS A GENERATED/BUNDLED FILE BY ESBUILD
if you want to view the source, please visit the github repository of this plugin
*/
`;

const prod = process.argv[2] === "production";

// Default output path if environment variable is not set
const outputPath = process.env.OUTPUT_PATH || ".";
const outfile = path.join(outputPath, "main.js");

const context = await esbuild.context({
	banner: {
		js: banner,
	},
	entryPoints: ["main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		...builtins,
	],
	format: "cjs",
	target: "es2018",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: outfile,
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
