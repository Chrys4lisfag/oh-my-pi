/**
 * Builds the browser relay extension and its distribution artifacts:
 * - `dist/extension/` — unpacked extension (load via chrome://extensions)
 * - `dist/omp-browser-relay-extension.zip` — packaged extension for GH releases
 * - `../coding-agent/src/tools/browser/relay/extension-assets/*.txt` —
 *   generated text assets embedded into the omp CLI so `omp browser-relay
 *   install` works from the compiled binary (same committed-generated-output
 *   pattern as tool-views.generated.js). Re-run this script after touching
 *   anything under `extension/` and commit the regenerated assets.
 *
 * Dependency-free on purpose: CI runs this without `bun install`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

const root = path.resolve(import.meta.dir, "..");
const repoRoot = path.resolve(root, "../..");
const dist = path.join(root, "dist");
const distExtension = path.join(dist, "extension");
const assetsDir = path.resolve(root, "../coding-agent/src/tools/browser/relay/extension-assets");

await fs.rm(dist, { recursive: true, force: true });
await fs.mkdir(distExtension, { recursive: true });

const bundle = await Bun.build({
	entrypoints: [path.join(root, "extension/background.ts")],
	outdir: distExtension,
	target: "browser",
	sourcemap: "none",
});
if (!bundle.success) {
	for (const log of bundle.logs) console.error(log);
	process.exit(1);
}

for (const file of ["manifest.json", "options.html", "options.js"]) {
	await Bun.write(path.join(distExtension, file), Bun.file(path.join(root, "extension", file)));
}
for (const file of ["LICENSE", "THIRD-PARTY-NOTICES.txt"]) {
	await Bun.write(path.join(distExtension, file), Bun.file(path.join(repoRoot, file)));
}

const archivePath = path.join(dist, "omp-browser-relay-extension.zip");
await fs.rm(archivePath, { force: true });

/**
 * Package `dist/extension/` with whatever archiver the host has.
 *
 * `zip` is not present on a stock Windows box (nor on many minimal Linux
 * images), which failed the whole workspace build here rather than just this
 * artifact. Tried in order: Info-ZIP, 7-Zip, then PowerShell's
 * `Compress-Archive`. All three produce a flat zip rooted at the extension
 * directory, which is what Chrome expects.
 */
async function packageExtension(): Promise<{ ok: true; via: string } | { ok: false; tried: string[] }> {
	const attempts: Array<{ via: string; run: () => Promise<{ exitCode: number; stderr: string }> }> = [
		{
			via: "zip",
			run: async () => {
				const r = await $`zip -qr ${archivePath} .`.cwd(distExtension).nothrow().quiet();
				return { exitCode: r.exitCode, stderr: r.stderr.toString() };
			},
		},
		{
			via: "7z",
			run: async () => {
				const r = await $`7z a -tzip -bso0 -bsp0 ${archivePath} .`.cwd(distExtension).nothrow().quiet();
				return { exitCode: r.exitCode, stderr: r.stderr.toString() };
			},
		},
		{
			via: "Compress-Archive",
			run: async () => {
				const r =
					await $`powershell -NoProfile -NonInteractive -Command ${`Compress-Archive -Path '${distExtension}\\*' -DestinationPath '${archivePath}' -Force`}`
						.nothrow()
						.quiet();
				return { exitCode: r.exitCode, stderr: r.stderr.toString() };
			},
		},
	];
	const tried: string[] = [];
	for (const attempt of attempts) {
		let result: { exitCode: number; stderr: string };
		try {
			result = await attempt.run();
		} catch (error) {
			// A missing binary rejects instead of exiting non-zero.
			tried.push(`${attempt.via}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		if (result.exitCode === 0 && (await Bun.file(archivePath).exists())) {
			return { ok: true, via: attempt.via };
		}
		tried.push(`${attempt.via}: exit ${result.exitCode}${result.stderr ? ` ${result.stderr.trim()}` : ""}`);
	}
	return { ok: false, tried };
}

const packaged = await packageExtension();
if (!packaged.ok) {
	console.error("could not package the extension; tried:");
	for (const line of packaged.tried) console.error(`  ${line}`);
	process.exit(1);
}

await fs.rm(assetsDir, { recursive: true, force: true });
const embeddedAssets = [
	["background.js", "background.js.txt"],
	["manifest.json", "manifest.json.txt"],
	["options.html", "options.html.txt"],
	["options.js", "options.js.txt"],
	["LICENSE", "LICENSE.txt"],
	["THIRD-PARTY-NOTICES.txt", "THIRD-PARTY-NOTICES.txt"],
] as const;
for (const [source, destination] of embeddedAssets) {
	await Bun.write(path.join(assetsDir, destination), Bun.file(path.join(distExtension, source)));
}

console.log("built:");
console.log(`  ${distExtension}`);
console.log(`  ${archivePath} (via ${packaged.via})`);
console.log(`  ${assetsDir} (embedded CLI assets — commit these)`);
