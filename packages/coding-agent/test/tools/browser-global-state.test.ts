import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as launch from "../../src/tools/browser/launch";
import {
	collectOrphanTargets,
	forgetSharedTarget,
	recordSharedTarget,
	resetOrphanRegistryForTest,
} from "../../src/tools/browser/orphan-registry";
import { acquireBrowser, browserKey, type BrowserHandle, releaseBrowser } from "../../src/tools/browser/registry";
import * as shared from "../../src/tools/browser/shared-daemon";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-global-"));
	roots.push(root);
	return root;
}

afterEach(async () => {
	spyOn(shared, "ensureSharedBrowser").mockRestore();
	spyOn(launch, "launchHeadlessBrowser").mockRestore();
	resetOrphanRegistryForTest();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("global browser state", () => {
	it("isolates project and global profiles and keeps headed profiles independent", () => {
		const project = browserKey({ kind: "headless", headless: true });
		const global = browserKey({ kind: "headless", headless: true, globalState: true });
		const headed = browserKey({ kind: "headless", headless: false, globalState: true });
		expect(global).not.toBe(project);
		expect(headed).not.toBe(global);
		expect(browserKey({ kind: "headless", headless: true, globalState: false })).toBe(project);
	});

	it("fails instead of substituting a temporary profile when the global broker is unavailable", async () => {
		spyOn(shared, "ensureSharedBrowser").mockResolvedValue(null);
		const temporaryLaunch = spyOn(launch, "launchHeadlessBrowser").mockRejectedValue(new Error("temporary launch"));
		await expect(
			acquireBrowser({ kind: "headless", headless: true, globalState: true }, { cwd: os.tmpdir() }),
		).rejects.toThrow("Shared browser daemon unavailable");
		expect(temporaryLaunch).not.toHaveBeenCalled();
	});

	it("rejects process-only file access rather than weakening the global profile contract", async () => {
		const temporaryLaunch = spyOn(launch, "launchHeadlessBrowser").mockRejectedValue(new Error("temporary launch"));
		await expect(
			acquireBrowser(
				{ kind: "headless", headless: true, globalState: true, allowFileAccess: true },
				{ cwd: os.tmpdir() },
			),
		).rejects.toThrow("allow_file_access");
		expect(temporaryLaunch).not.toHaveBeenCalled();
	});

	it("disconnects a global lease without closing Chromium or deleting its persisted profile", async () => {
		const root = await temporaryRoot();
		const profile = path.join(root, "omp.browser.headless.profile");
		const preferences = path.join(profile, "Default", "Preferences");
		await fs.mkdir(path.dirname(preferences), { recursive: true });
		await fs.writeFile(preferences, "persisted browser preferences");
		let disconnected = false;
		let closed = false;
		const handle = {
			key: browserKey({ kind: "headless", headless: true, globalState: true }),
			kind: { kind: "headless", headless: true, globalState: true },
			refCount: 1,
			sharedDaemon: { name: "omp.browser.headless", projectDir: root, runtimeDir: root },
			userDataDir: profile,
			browser: {
				connected: true,
				disconnect: () => {
					disconnected = true;
				},
				close: async () => {
					closed = true;
				},
			},
			stealth: { browserSession: null, override: null },
		} as unknown as BrowserHandle;
		await releaseBrowser(handle, { kill: true });
		expect(disconnected).toBe(true);
		expect(closed).toBe(false);
		expect(await fs.readFile(preferences, "utf8")).toBe("persisted browser preferences");
	});

	it("keeps durable target ownership in the global runtime across project scopes", async () => {
		const root = await temporaryRoot();
		const runtimeDir = path.join(root, "global-browser");
		const first = { projectDir: path.join(root, "project-a"), runtimeDir, daemonName: "omp.browser.headless" };
		const second = { ...first, projectDir: path.join(root, "project-b") };
		await recordSharedTarget(first, "owned-target");
		const ownerFile = path.join(runtimeDir, `${first.daemonName}.targets`, `${process.pid}.json`);
		expect((await Bun.file(ownerFile).json()).targets).toEqual(["owned-target"]);
		await forgetSharedTarget(second, "owned-target");
		expect(await Bun.file(ownerFile).exists()).toBe(false);

		const staleFile = path.join(runtimeDir, `${first.daemonName}.targets`, "dead.json");
		await fs.writeFile(staleFile, JSON.stringify({ pid: process.pid + 1, updatedAt: 0, targets: ["orphan"] }));
		const scan = await collectOrphanTargets(second, { isAlive: () => false, graceMs: 0 });
		expect(scan.owners.map(owner => owner.targetIds)).toEqual([["orphan"]]);
	});
});
