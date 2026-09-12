import { describe, expect, it } from "bun:test";
import { getExtensionNameFromPath } from "@oh-my-pi/pi-coding-agent/discovery/helpers";

describe("getExtensionNameFromPath", () => {
	it("names a manifest plugin after its directory, not its source folder", () => {
		// A package.json manifest may declare `./src/index.ts`. Naming that "src"
		// collides with every other manifest plugin and makes the
		// `extension-module:<name>` id in `disabledExtensions` unguessable.
		expect(getExtensionNameFromPath("/home/u/.omp/extensions/omp-haimaker-budget-wait/src/index.ts")).toBe(
			"omp-haimaker-budget-wait",
		);
		expect(getExtensionNameFromPath("C:\\Users\\u\\.omp\\extensions\\my-plugin\\dist\\index.js")).toBe("my-plugin");
	});

	it("keeps naming plain directory extensions after the directory holding index", () => {
		expect(getExtensionNameFromPath("/home/u/.omp/extensions/gemini-unblocker/index.ts")).toBe("gemini-unblocker");
	});

	it("keeps naming single-file extensions after the file", () => {
		expect(getExtensionNameFromPath("/home/u/.omp/extensions/caveman.ts")).toBe("caveman");
	});

	it("does not climb past the extensions root", () => {
		// `extensions/src/index.ts` is a real extension named "src"; climbing here
		// would name every such extension "extensions".
		expect(getExtensionNameFromPath("/home/u/.omp/extensions/src/index.ts")).toBe("src");
	});
});
