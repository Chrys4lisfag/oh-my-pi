/**
 * Regression: running multiple omp instances against one `~/.omp/agent/config.yml`
 * lost profiles. `Settings.#saveNow` re-reads under a file lock but re-applied
 * only whole modified *paths* — and `profiles.items` is a single path holding
 * the entire profile map. So instance B's `set("profiles.items", staleMap)`
 * overwrote instance A's just-added profile (lost update; the lock only
 * prevented file corruption, not the logical clobber).
 *
 * Fix: `setProfileItem` / `deleteProfileItem` track the touched profile *keys*
 * and the save merges only those into the freshest on-disk map, leaving a
 * concurrent instance's independently added/edited/deleted profiles intact.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-ai";
import { cfgModelRoles } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { cfgProfilesActive, cfgProfilesItems } from "@oh-my-pi/pi-coding-agent/config/profiles";
import { cfgDefaultThinkingLevel } from "@oh-my-pi/pi-coding-agent/session/settings";
import { cfgSetupVersion } from "@oh-my-pi/pi-coding-agent/modes/settings";
import {
	onSettingsSynchronized,
	resetSettingsForTest,
	resetSettingsForTestAsync,
	Settings,
} from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

const SNAP = { modelRoles: { default: "anthropic/claude-sonnet-4" }, defaultThinkingLevel: "high" };
type TestProfileSnapshot = { modelRoles: Record<string, string>; defaultThinkingLevel: string };
function profileSnapshot(settings: Settings, name: string): TestProfileSnapshot | undefined {
	return cfgProfilesItems.get(settings)[name] as TestProfileSnapshot | undefined;
}

describe("profiles multi-instance persistence", () => {
	let dir: string;

	beforeEach(async () => {
		resetSettingsForTest();
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-profiles-"));
	});

	afterEach(async () => {
		AgentStorage.close();
		await resetSettingsForTestAsync();
		await removeWithRetries(dir);
	});

	async function load(overrides: Record<string, unknown> = {}) {
		const s = await Settings.loadIsolated({ agentDir: dir, cwd: dir, overrides });
		return s;
	}

	function rewriteConfig(mutator: (config: Record<string, any>) => void): void {
		const configPath = path.join(dir, "config.yml");
		const config = YAML.parse(fsSync.readFileSync(configPath, "utf8")) as Record<string, any>;
		mutator(config);
		fsSync.writeFileSync(configPath, YAML.stringify(config, null, 2));
	}

	async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!predicate()) {
			if (Date.now() >= deadline) throw new Error("Timed out waiting for settings synchronization");
			await Bun.sleep(25);
		}
	}

	it("keeps both profiles when two stale instances each add one and save", async () => {
		const seed = await load();
		seed.setProfileItem("base", SNAP);
		await seed.flush();

		// Both instances load the same baseline, then each adds a different profile
		// from its now-stale in-memory map — the concurrent-write scenario.
		const a = await load();
		const b = await load();
		a.setProfileItem("from-a", SNAP);
		b.setProfileItem("from-b", SNAP);
		await a.flush();
		await b.flush();

		const reader = await load();
		const items = cfgProfilesItems.get(reader) as Record<string, unknown>;
		expect(Object.keys(items).sort()).toEqual(["base", "from-a", "from-b"]);
	});

	it("propagates a delete without resurrecting it from a concurrent writer's stale map", async () => {
		const seed = await load();
		seed.setProfileItem("keep", SNAP);
		seed.setProfileItem("drop", SNAP);
		await seed.flush();

		const a = await load();
		const b = await load();
		a.deleteProfileItem("drop");
		b.setProfileItem("from-b", SNAP);
		await a.flush();
		await b.flush();

		const reader = await load();
		const items = cfgProfilesItems.get(reader) as Record<string, unknown>;
		expect(Object.keys(items).sort()).toEqual(["from-b", "keep"]);
	});

	it("preserves an external profile written between this instance's load and save", async () => {
		const seed = await load();
		seed.setProfileItem("base", SNAP);
		await seed.flush();

		const a = await load(); // loads {base}
		a.setProfileItem("from-a", SNAP);

		// Another instance adds a profile AFTER `a` loaded but BEFORE `a` saves.
		const external = await load();
		external.setProfileItem("external", SNAP);
		await external.flush();

		await a.flush();

		const reader = await load();
		const items = cfgProfilesItems.get(reader) as Record<string, unknown>;
		expect(Object.keys(items).sort()).toEqual(["base", "external", "from-a"]);
	});
	it("does not resurrect a deleted profile when a stale instance updates that same name", async () => {
		const seed = await load();
		seed.setProfileItem("shared", SNAP);
		await seed.flush();

		const stale = await load();
		const deleter = await load();
		stale.setProfileItem("shared", {
			modelRoles: { default: "xai-oauth/grok-4.5" },
			defaultThinkingLevel: "auto",
		});
		deleter.deleteProfileItem("shared");
		await deleter.flush();
		await stale.flush();

		const reader = await load();
		expect(cfgProfilesItems.get(reader)).toEqual({});
	});

	it("deletion wins when the stale same-profile update saves first", async () => {
		const seed = await load();
		seed.setProfileItem("shared", SNAP);
		await seed.flush();

		const stale = await load();
		const deleter = await load();
		stale.setProfileItem("shared", {
			modelRoles: { default: "xai-oauth/grok-4.5" },
			defaultThinkingLevel: "auto",
		});
		deleter.deleteProfileItem("shared");
		await stale.flush();
		await deleter.flush();

		const reader = await load();
		expect(cfgProfilesItems.get(reader)).toEqual({});
	});

	it("allows a fresh instance to intentionally recreate a deleted profile name", async () => {
		const seed = await load();
		seed.setProfileItem("shared", SNAP);
		await seed.flush();
		const deleter = await load();
		deleter.deleteProfileItem("shared");
		await deleter.flush();

		const fresh = await load();
		const replacement = {
			modelRoles: { default: "openai-codex/gpt-5.6" },
			defaultThinkingLevel: "medium",
		};
		fresh.setProfileItem("shared", replacement);
		await fresh.flush();

		const reader = await load();
		expect(cfgProfilesItems.get(reader)).toEqual({ shared: replacement });
	});

	it("keeps a stale selected identity local without resurrecting its deleted definition", async () => {
		const seed = await load();
		seed.setProfileItem("shared", SNAP);
		cfgProfilesActive.set(seed, "shared");
		await seed.flush();

		const stale = await load();
		const deleter = await load();
		deleter.deleteProfileItem("shared");
		cfgProfilesActive.set(deleter, "");
		await deleter.flush();

		stale.setProfileItem("shared", {
			modelRoles: { default: "xai-oauth/grok-4.5" },
			defaultThinkingLevel: "auto",
		});
		cfgProfilesActive.set(stale, "shared");
		await stale.flush();

		const disk = YAML.parse(fsSync.readFileSync(path.join(dir, "config.yml"), "utf8")) as Record<string, any>;
		expect(disk.profiles.items).toEqual({});
		const reader = await load();
		expect(cfgProfilesActive.get(reader)).toBe("shared");
		expect(profileSnapshot(reader, "shared")).toBeDefined();
	});

	it("keeps create intent when a new profile is edited again before its first flush", async () => {
		const writer = await load();
		writer.setProfileItem("new", SNAP);
		const edited = {
			modelRoles: { default: "anthropic/claude-opus-4-6" },
			defaultThinkingLevel: "xhigh",
		};
		writer.setProfileItem("new", edited);
		await writer.flush();

		const reader = await load();
		expect(cfgProfilesItems.get(reader)).toEqual({ new: edited });
	});
	it("persists a profile created and renamed before its first debounce flush", async () => {
		const settings = await load();
		settings.setProfileItem("old", SNAP);
		settings.activateProfile("old", SNAP);
		settings.renameProfileItem("old", "new", SNAP, true);
		cfgDefaultThinkingLevel.set(settings, Effort.Medium);
		await settings.flush();

		const reader = await load();
		expect(cfgProfilesItems.get(reader)).not.toHaveProperty("old");
		expect(profileSnapshot(reader, "new")?.defaultThinkingLevel).toBe(Effort.Medium);
		expect(cfgProfilesActive.get(reader)).toBe("new");
	});

	it("collapses an inverse rename before the debounce flush", async () => {
		const original = {
			modelRoles: { default: "anthropic/original" },
			defaultThinkingLevel: Effort.High,
		};
		const settings = await load();
		settings.setProfileItem("alpha", original);
		settings.activateProfile("alpha", original);
		settings.renameProfileItem("alpha", "beta", original, true);
		settings.renameProfileItem("beta", "alpha", original, true);
		await settings.flush();

		expect(cfgProfilesItems.get(settings)).toEqual({ alpha: original });
		expect(cfgProfilesActive.get(settings)).toBe("alpha");
		const reader = await load();
		expect(cfgProfilesItems.get(reader)).toEqual({ alpha: original });
		expect(cfgProfilesActive.get(reader)).toBe("alpha");
	});

	it("does not rename a stale source after another instance deletes it", async () => {
		const seed = await load();
		seed.setProfileItem("old", SNAP);
		await seed.flush();

		const stale = await load();
		const deleter = await load();
		deleter.deleteProfileItem("old");
		await deleter.flush();
		stale.renameProfileItem("old", "new", SNAP, false);
		await stale.flush();

		const reader = await load();
		expect(cfgProfilesItems.get(reader)).toEqual({});
	});

	it("does not overwrite a rename destination concurrently created by another instance", async () => {
		const seed = await load();
		seed.setProfileItem("old", SNAP);
		seed.activateProfile("old", SNAP);
		await seed.flush();

		const stale = await load();
		const creator = await load();
		const concurrent = {
			modelRoles: { default: "openai-codex/gpt-5.6" },
			defaultThinkingLevel: "medium",
		};
		creator.setProfileItem("new", concurrent);
		await creator.flush();

		const saveEntered = Promise.withResolvers<void>();
		const releaseSave = Promise.withResolvers<void>();
		const open = fsSync.promises.open.bind(fsSync.promises);
		const configPath = path.join(dir, "config.yml");
		let intercepted = false;
		const openSpy = vi.spyOn(fsSync.promises, "open").mockImplementation(async (file, flags, mode) => {
			if (
				!intercepted &&
				path.dirname(String(file)) === path.dirname(configPath) &&
				path.basename(String(file)).startsWith(`${path.basename(configPath)}.`) &&
				String(file).endsWith(".tmp")
			) {
				intercepted = true;
				saveEntered.resolve();
				await releaseSave.promise;
			}
			return open(file, flags, mode);
		});
		try {
			stale.renameProfileItem("old", "new", SNAP, true);
			const firstFlush = stale.flush();
			await saveEntered.promise;
			cfgDefaultThinkingLevel.set(stale, Effort.Low);
			releaseSave.resolve();
			await firstFlush;
			await stale.flush();

			expect(cfgProfilesActive.get(stale)).toBe("old");
			expect(cfgDefaultThinkingLevel.get(stale)).toBe(Effort.Low);
			expect(profileSnapshot(stale, "new")).toEqual(concurrent);
			const reader = await load();
			expect(cfgProfilesItems.get(reader)).toEqual({
				old: { ...SNAP, defaultThinkingLevel: Effort.Low },
				new: concurrent,
			});
		} finally {
			releaseSave.resolve();
			openSpy.mockRestore();
		}
	});
	it("keeps an active-profile edit made while its rename save is in flight", async () => {
		const seed = await load();
		seed.setProfileItem("old", SNAP);
		seed.activateProfile("old", SNAP);
		await seed.flush();

		const settings = await load();
		const saveEntered = Promise.withResolvers<void>();
		const releaseSave = Promise.withResolvers<void>();
		const open = fsSync.promises.open.bind(fsSync.promises);
		const configPath = path.join(dir, "config.yml");
		let intercepted = false;
		const openSpy = vi.spyOn(fsSync.promises, "open").mockImplementation(async (file, flags, mode) => {
			if (
				!intercepted &&
				path.dirname(String(file)) === path.dirname(configPath) &&
				path.basename(String(file)).startsWith(`${path.basename(configPath)}.`) &&
				String(file).endsWith(".tmp")
			) {
				intercepted = true;
				saveEntered.resolve();
				await releaseSave.promise;
			}
			return open(file, flags, mode);
		});
		try {
			settings.renameProfileItem("old", "new", SNAP, true);
			const firstFlush = settings.flush();
			await saveEntered.promise;
			cfgDefaultThinkingLevel.set(settings, Effort.Medium);
			releaseSave.resolve();
			await firstFlush;
			await settings.flush();

			const reader = await load();
			expect(cfgProfilesItems.get(reader)).not.toHaveProperty("old");
			expect(profileSnapshot(reader, "new")?.defaultThinkingLevel).toBe(Effort.Medium);
			expect(cfgProfilesActive.get(reader)).toBe("new");
		} finally {
			releaseSave.resolve();
			openSpy.mockRestore();
		}
	});

	it("activates the freshest target snapshot without writing a stale copy", async () => {
		const old = { modelRoles: { default: "anthropic/old" }, defaultThinkingLevel: "low" };
		const staleTarget = { modelRoles: { default: "anthropic/stale" }, defaultThinkingLevel: "medium" };
		const freshTarget = { modelRoles: { default: "openai/fresh" }, defaultThinkingLevel: "high" };
		const seed = await load();
		seed.setProfileItem("old", old);
		seed.setProfileItem("target", staleTarget);
		cfgProfilesActive.set(seed, "old");
		cfgModelRoles.set(seed, old.modelRoles);
		await seed.flush();

		const stale = await load();
		rewriteConfig(config => {
			config.profiles.items.target = freshTarget;
		});
		stale.activateProfile("target", staleTarget);
		await stale.flush();

		expect(cfgProfilesActive.get(stale)).toBe("target");
		expect(stale.getModelRole("default")).toBe("openai/fresh");
		expect(cfgDefaultThinkingLevel.get(stale)).toBe(Effort.High);
		const reader = await load();
		expect(cfgProfilesItems.get(reader).target).toEqual(freshTarget);
		expect(cfgProfilesActive.get(reader)).toBe("target");
		expect(cfgModelRoles.get(reader)).toEqual(freshTarget.modelRoles);
		expect(cfgDefaultThinkingLevel.get(reader)).toBe(Effort.High);
	});

	it("renames the freshest source without overwriting a concurrently changed active marker", async () => {
		const other = { modelRoles: { default: "openai/other" }, defaultThinkingLevel: "high" };
		const fresh = { modelRoles: { default: "openai/fresh-source" }, defaultThinkingLevel: "medium" };
		const seed = await load();
		seed.setProfileItem("old", SNAP);
		seed.setProfileItem("other", other);
		cfgProfilesActive.set(seed, "old");
		cfgModelRoles.set(seed, SNAP.modelRoles);
		await seed.flush();

		const stale = await load();
		rewriteConfig(config => {
			config.profiles.items.old = fresh;
			config.profiles.active = "other";
			config.modelRoles = other.modelRoles;
			config.defaultThinkingLevel = other.defaultThinkingLevel;
		});
		stale.renameProfileItem("old", "new", SNAP, true);
		await stale.flush();

		const reader = await load();
		expect(cfgProfilesItems.get(reader)).toEqual({ new: fresh, other });
		expect(cfgProfilesActive.get(reader)).toBe("other");
		expect(cfgModelRoles.get(reader)).toEqual(other.modelRoles);
	});

	it("does not overwrite a concurrently changed active marker when deleting stale active state", async () => {
		const other = { modelRoles: { default: "openai/other" }, defaultThinkingLevel: "high" };
		const seed = await load();
		seed.setProfileItem("selected", SNAP);
		seed.setProfileItem("other", other);
		cfgProfilesActive.set(seed, "selected");
		cfgModelRoles.set(seed, SNAP.modelRoles);
		await seed.flush();

		const stale = await load();
		rewriteConfig(config => {
			config.profiles.active = "other";
			config.modelRoles = other.modelRoles;
			config.defaultThinkingLevel = other.defaultThinkingLevel;
		});
		stale.deleteProfileItem("selected");
		await stale.flush();

		const reader = await load();
		expect(cfgProfilesItems.get(reader)).toEqual({ other });
		expect(cfgProfilesActive.get(reader)).toBe("other");
		expect(cfgModelRoles.get(reader)).toEqual(other.modelRoles);
	});

	it("preserves pinned profile-owned slots and unrelated overrides after final deletion", async () => {
		const seed = await load();
		seed.setProfileItem("only", SNAP);
		cfgProfilesActive.set(seed, "only");
		cfgModelRoles.set(seed, SNAP.modelRoles);
		cfgDefaultThinkingLevel.set(seed, Effort.High);
		await seed.flush();
		await fs.mkdir(path.join(dir, ".omp"), { recursive: true });
		await fs.writeFile(
			path.join(dir, ".omp", "config.yml"),
			YAML.stringify({ modelRoles: { smol: "project/smol" } }, null, 2),
		);

		const peer = await load({
			modelRoles: { default: "runtime/default", advisor: "runtime/advisor" },
			defaultThinkingLevel: "xhigh",
		});
		expect(peer.getModelRole("default")).toBe(SNAP.modelRoles.default);
		expect(peer.getModelRole("advisor")).toBe("runtime/advisor");
		expect(peer.getModelRole("smol")).toBe("project/smol");
		rewriteConfig(config => {
			config.theme = { dark: "anthracite" };
		});
		await peer.syncFromDisk();
		expect(peer.getModelRole("advisor")).toBe("runtime/advisor");
		expect(peer.getModelRole("smol")).toBe("project/smol");

		rewriteConfig(config => {
			config.profiles = { active: "", items: {} };
			config.modelRoles = { default: "global/default" };
			config.defaultThinkingLevel = "low";
		});
		await peer.syncFromDisk();
		expect(peer.getModelRole("default")).toBe(SNAP.modelRoles.default);
		expect(peer.getModelRole("advisor")).toBe("runtime/advisor");
		expect(peer.getModelRole("smol")).toBe("project/smol");
		expect(cfgDefaultThinkingLevel.get(peer)).toBe(Effort.High);
	});

	it("does not adopt another terminal's first activation when local selection is empty", async () => {
		const emptyTerminal = await load();
		const initialRoles = cfgModelRoles.get(emptyTerminal);
		const initialThinking = cfgDefaultThinkingLevel.get(emptyTerminal);
		const writer = await load();
		writer.setProfileItem("first", SNAP);
		writer.activateProfile("first", SNAP);
		await writer.flush();

		await waitFor(() => "first" in cfgProfilesItems.get(emptyTerminal));
		expect(cfgProfilesActive.get(emptyTerminal)).toBe("");
		expect(cfgModelRoles.get(emptyTerminal)).toEqual(initialRoles);
		expect(cfgDefaultThinkingLevel.get(emptyTerminal)).toBe(initialThinking);
	});

	it("does not switch other instances when one instance switches active profile", async () => {
		const seed = await load();
		seed.setProfileItem("work", {
			modelRoles: { default: "anthropic/initial" },
			defaultThinkingLevel: "high",
		});
		seed.setProfileItem("other", {
			modelRoles: { default: "openai/other" },
			defaultThinkingLevel: "low",
		});
		cfgProfilesActive.set(seed, "work");
		cfgModelRoles.set(seed, { default: "anthropic/initial" });
		await seed.flush();

		const writer = await load();
		const peer = await seed.cloneForCwd(dir);

		writer.activateProfile("other", {
			modelRoles: { default: "openai/other" },
			defaultThinkingLevel: "low",
		});
		await writer.flush();
		await Bun.sleep(400);

		expect(cfgProfilesActive.get(peer)).toBe("work");
		expect(peer.getModelRole("default")).toBe("anthropic/initial");
	});

	it("propagates a persisted thinking change to every terminal using the same profile", async () => {
		const seed = await load();
		seed.setProfileItem("gpt-edu", SNAP);
		seed.activateProfile("gpt-edu", SNAP);
		await seed.flush();

		const first = await load();
		const second = await load();
		cfgDefaultThinkingLevel.set(first, Effort.Medium);
		await first.flush();
		await second.syncFromDisk();
		await first.syncFromDisk();

		expect(cfgProfilesActive.get(first)).toBe("gpt-edu");
		expect(cfgProfilesActive.get(second)).toBe("gpt-edu");
		expect(cfgDefaultThinkingLevel.get(first)).toBe(Effort.Medium);
		expect(cfgDefaultThinkingLevel.get(second)).toBe(Effort.Medium);
		expect(profileSnapshot(first, "gpt-edu")?.defaultThinkingLevel).toBe(Effort.Medium);
		expect(profileSnapshot(second, "gpt-edu")?.defaultThinkingLevel).toBe(Effort.Medium);
	});

	it("propagates persisted model-role edits to every terminal using the same profile", async () => {
		const seed = await load();
		seed.setProfileItem("gpt-edu", SNAP);
		seed.activateProfile("gpt-edu", SNAP);
		await seed.flush();

		const first = await load();
		const second = await load();
		first.setModelRole("default", "openai-codex/gpt-5.6");
		await first.flush();
		await second.syncFromDisk();
		await first.syncFromDisk();

		expect(first.getModelRole("default")).toBe("openai-codex/gpt-5.6");
		expect(second.getModelRole("default")).toBe("openai-codex/gpt-5.6");
		expect(profileSnapshot(first, "gpt-edu")?.modelRoles.default).toBe("openai-codex/gpt-5.6");
		expect(profileSnapshot(second, "gpt-edu")?.modelRoles.default).toBe("openai-codex/gpt-5.6");
	});

	it("keeps stale granular edits local after the persisted definition is deleted", async () => {
		const seed = await load();
		seed.setProfileItem("shared", SNAP);
		seed.activateProfile("shared", SNAP);
		await seed.flush();

		const stale = await load();
		const deleter = await load();
		cfgDefaultThinkingLevel.set(stale, Effort.Medium);
		deleter.deleteProfileItem("shared");
		await deleter.flush();
		await stale.flush();

		const disk = YAML.parse(fsSync.readFileSync(path.join(dir, "config.yml"), "utf8")) as Record<string, any>;
		expect(disk.profiles.items).toEqual({});
		const reader = await load();
		expect(cfgProfilesActive.get(reader)).toBe("shared");
		expect(cfgDefaultThinkingLevel.get(reader)).toBe(Effort.Medium);
	});

	it("merges disjoint same-profile role edits in either flush order", async () => {
		const initial = {
			modelRoles: { default: "anthropic/default-old", advisor: "anthropic/advisor-old" },
			defaultThinkingLevel: "high",
		};
		const seed = await load();
		seed.setProfileItem("shared", initial);
		seed.activateProfile("shared", initial);
		await seed.flush();

		const first = await load();
		const second = await load();
		first.setModelRole("default", "openai/default-a");
		second.setModelRole("advisor", "google/advisor-b");
		await first.flush();
		await second.flush();

		const third = await load();
		const fourth = await load();
		third.setModelRole("default", "openai/default-c");
		fourth.setModelRole("advisor", "google/advisor-d");
		await fourth.flush();
		await third.flush();

		const reader = await load();
		expect(profileSnapshot(reader, "shared")?.modelRoles).toEqual({
			default: "openai/default-c",
			advisor: "google/advisor-d",
		});
		expect(cfgModelRoles.get(reader)).toEqual({ default: "openai/default-c", advisor: "google/advisor-d" });
	});

	it("merges concurrent same-profile thinking and role edits", async () => {
		const seed = await load();
		seed.setProfileItem("shared", SNAP);
		seed.activateProfile("shared", SNAP);
		await seed.flush();

		const thinkingWriter = await load();
		const roleWriter = await load();
		cfgDefaultThinkingLevel.set(thinkingWriter, Effort.Medium);
		roleWriter.setModelRole("advisor", "openai/advisor-new");
		await Promise.all([thinkingWriter.flush(), roleWriter.flush()]);

		const reader = await load();
		expect(profileSnapshot(reader, "shared")).toEqual({
			modelRoles: { ...SNAP.modelRoles, advisor: "openai/advisor-new" },
			defaultThinkingLevel: Effort.Medium,
		});
		expect(cfgDefaultThinkingLevel.get(reader)).toBe(Effort.Medium);
	});

	it("requeues same-profile role and thinking deltas after an atomic write failure", async () => {
		const seed = await load();
		seed.setProfileItem("shared", SNAP);
		seed.activateProfile("shared", SNAP);
		await seed.flush();

		const writer = await load();
		cfgDefaultThinkingLevel.set(writer, Effort.Medium);
		writer.setModelRole("advisor", "openai/advisor-retried");

		const open = fsSync.promises.open.bind(fsSync.promises);
		const configPath = path.join(dir, "config.yml");
		let failed = false;
		const openSpy = vi.spyOn(fsSync.promises, "open").mockImplementation(async (file, flags, mode) => {
			if (
				!failed &&
				path.dirname(String(file)) === path.dirname(configPath) &&
				path.basename(String(file)).startsWith(`${path.basename(configPath)}.`) &&
				String(file).endsWith(".tmp")
			) {
				failed = true;
				throw new Error("synthetic atomic write failure");
			}
			return open(file, flags, mode);
		});
		try {
			await expect(writer.flush()).rejects.toThrow("synthetic atomic write failure");
			expect(cfgProfilesActive.get(writer)).toBe("shared");

			await writer.flush();

			const disk = YAML.parse(fsSync.readFileSync(configPath, "utf8")) as Record<string, any>;
			expect(disk.profiles.items.shared).toEqual({
				modelRoles: { ...SNAP.modelRoles, advisor: "openai/advisor-retried" },
				defaultThinkingLevel: Effort.Medium,
			});
			expect(disk.profiles.active).toBe("shared");
			expect(cfgProfilesActive.get(writer)).toBe("shared");
		} finally {
			openSpy.mockRestore();
		}
	});

	it("merges a same-profile role deletion with a sibling role update", async () => {
		const initial = {
			modelRoles: { default: "anthropic/default-old", advisor: "anthropic/advisor-old" },
			defaultThinkingLevel: "high",
		};
		const seed = await load();
		seed.setProfileItem("shared", initial);
		seed.activateProfile("shared", initial);
		await seed.flush();

		const deleter = await load();
		const updater = await load();
		deleter.setModelRole("default", undefined);
		updater.setModelRole("advisor", "google/advisor-new");
		await updater.flush();
		await deleter.flush();

		const reader = await load();
		expect(profileSnapshot(reader, "shared")?.modelRoles).toEqual({ advisor: "google/advisor-new" });
		expect(cfgModelRoles.get(reader)).toEqual({ advisor: "google/advisor-new" });
	});

	it("keeps explicit runtime overrides while syncing the underlying same-profile snapshot", async () => {
		const seed = await load();
		seed.setProfileItem("gpt-edu", SNAP);
		seed.activateProfile("gpt-edu", SNAP);
		await seed.flush();

		const writer = await load();
		const overridden = await load();
		cfgModelRoles.override(overridden, { default: "google/local-override" });
		cfgDefaultThinkingLevel.override(overridden, Effort.XHigh);

		writer.setModelRole("default", "openai-codex/gpt-5.6");
		cfgDefaultThinkingLevel.set(writer, Effort.Medium);
		await writer.flush();
		await overridden.syncFromDisk();

		expect(overridden.getModelRole("default")).toBe("google/local-override");
		expect(cfgDefaultThinkingLevel.get(overridden)).toBe(Effort.XHigh);
		expect(profileSnapshot(overridden, "gpt-edu")?.modelRoles.default).toBe("openai-codex/gpt-5.6");
		expect(profileSnapshot(overridden, "gpt-edu")?.defaultThinkingLevel).toBe(Effort.Medium);
	});

	it("shares an edited profile without corrupting another startup profile's live fields", async () => {
		const beta = { modelRoles: { default: "google/beta" }, defaultThinkingLevel: Effort.Low };
		const seed = await load();
		seed.setProfileItem("alpha", SNAP);
		seed.setProfileItem("beta", beta);
		seed.activateProfile("alpha", SNAP);
		await seed.flush();

		const alphaTerminal = await load();
		const betaTerminal = await load();
		betaTerminal.activateProfile("beta", beta);
		await betaTerminal.flush();
		await alphaTerminal.syncFromDisk();

		alphaTerminal.setModelRole("default", "openai/alpha-new");
		cfgDefaultThinkingLevel.set(alphaTerminal, Effort.Medium);
		await alphaTerminal.flush();
		await betaTerminal.syncFromDisk();
		await alphaTerminal.syncFromDisk();

		expect(cfgProfilesActive.get(alphaTerminal)).toBe("alpha");
		expect(alphaTerminal.getModelRole("default")).toBe("openai/alpha-new");
		expect(cfgDefaultThinkingLevel.get(alphaTerminal)).toBe(Effort.Medium);
		expect(cfgProfilesActive.get(betaTerminal)).toBe("beta");
		expect(betaTerminal.getModelRole("default")).toBe("google/beta");
		expect(cfgDefaultThinkingLevel.get(betaTerminal)).toBe(Effort.Low);

		const reader = await load();
		expect(cfgProfilesActive.get(reader)).toBe("beta");
		expect(reader.getModelRole("default")).toBe("google/beta");
		expect(cfgDefaultThinkingLevel.get(reader)).toBe(Effort.Low);
		expect(cfgProfilesItems.get(reader).alpha).toEqual({
			modelRoles: { default: "openai/alpha-new" },
			defaultThinkingLevel: Effort.Medium,
		});
	});

	it("does not overwrite a local mutation that arrives during an external sync read", async () => {
		const seed = await load();
		seed.setProfileItem("base", SNAP);
		seed.activateProfile("base", SNAP);
		await seed.flush();

		const settings = await load();
		const readEntered = Promise.withResolvers<void>();
		const releaseRead = Promise.withResolvers<void>();
		const readFile = fsSync.promises.readFile.bind(fsSync.promises);
		const configPath = path.join(dir, "config.yml");
		let intercepted = false;
		const readSpy = vi.spyOn(fsSync.promises, "readFile").mockImplementation((async (
			file: fsSync.PathLike | fsSync.promises.FileHandle,
			options?: unknown,
		) => {
			const content = await readFile(file, options as never);
			if (!intercepted && path.normalize(String(file)) === path.normalize(configPath)) {
				intercepted = true;
				readEntered.resolve();
				await releaseRead.promise;
			}
			return content;
		}) as never);
		try {
			const synchronization = settings.syncFromDisk();
			await readEntered.promise;
			settings.setProfileItem("created-during-read", {
				modelRoles: { default: "openai/local" },
				defaultThinkingLevel: Effort.Medium,
			});
			releaseRead.resolve();
			expect(await synchronization).toBe(false);
			expect(cfgProfilesItems.get(settings)).toHaveProperty("created-during-read");
			await settings.flush();

			const reader = await load();
			expect(cfgProfilesItems.get(reader)).toHaveProperty("created-during-read");
		} finally {
			releaseRead.resolve();
			readSpy.mockRestore();
		}
	});

	it("keeps its active profile when an unrelated save merges another terminal's activation", async () => {
		const work = { modelRoles: { default: "anthropic/work" }, defaultThinkingLevel: "medium" };
		const other = { modelRoles: { default: "openai/other" }, defaultThinkingLevel: "low" };
		const seed = await load();
		seed.setProfileItem("work", work);
		seed.setProfileItem("other", other);
		cfgProfilesActive.set(seed, "work");
		cfgModelRoles.set(seed, work.modelRoles);
		cfgDefaultThinkingLevel.set(seed, Effort.Medium);
		await seed.flush();

		const stale = await seed.cloneForCwd(dir);
		stale.cancelIfSessionOwned();
		const writer = await load();
		writer.activateProfile("other", other);
		await writer.flush();

		cfgSetupVersion.set(stale, 2);
		await stale.flush();

		expect(cfgProfilesActive.get(stale)).toBe("work");
		expect(stale.getModelRole("default")).toBe("anthropic/work");
		expect(cfgDefaultThinkingLevel.get(stale)).toBe(Effort.Medium);
		const reader = await load();
		expect(cfgSetupVersion.get(reader)).toBe(2);
		expect(cfgProfilesActive.get(reader)).toBe("other");
		expect(reader.getModelRole("default")).toBe("openai/other");
	});

	it("keeps an activation made while an unrelated save is in flight", async () => {
		const work = { modelRoles: { default: "anthropic/work" }, defaultThinkingLevel: "medium" };
		const foreign = { modelRoles: { default: "openai/foreign" }, defaultThinkingLevel: "low" };
		const latest = { modelRoles: { default: "google/latest" }, defaultThinkingLevel: "high" };
		const seed = await load();
		seed.setProfileItem("work", work);
		seed.setProfileItem("foreign", foreign);
		seed.setProfileItem("latest", latest);
		cfgProfilesActive.set(seed, "work");
		cfgModelRoles.set(seed, work.modelRoles);
		await seed.flush();

		const settings = await seed.cloneForCwd(dir);
		settings.cancelIfSessionOwned();
		const writer = await load();
		writer.activateProfile("foreign", foreign);
		await writer.flush();

		const saveEntered = Promise.withResolvers<void>();
		const releaseSave = Promise.withResolvers<void>();
		const open = fsSync.promises.open.bind(fsSync.promises);
		const configPath = path.join(dir, "config.yml");
		let intercepted = false;
		const openSpy = vi.spyOn(fsSync.promises, "open").mockImplementation(async (file, flags, mode) => {
			if (
				!intercepted &&
				path.dirname(String(file)) === path.dirname(configPath) &&
				path.basename(String(file)).startsWith(`${path.basename(configPath)}.`) &&
				String(file).endsWith(".tmp")
			) {
				intercepted = true;
				saveEntered.resolve();
				await releaseSave.promise;
			}
			return open(file, flags, mode);
		});
		const createdDuringSave = {
			modelRoles: { default: "anthropic/concurrent" },
			defaultThinkingLevel: "medium",
		};
		try {
			cfgSetupVersion.set(settings, 2);
			const firstFlush = settings.flush();
			await saveEntered.promise;
			settings.activateProfile("latest", latest);
			cfgSetupVersion.set(settings, 3);
			settings.setProfileItem("created-during-save", createdDuringSave);
			releaseSave.resolve();
			await firstFlush;

			expect(cfgProfilesActive.get(settings)).toBe("latest");
			expect(cfgSetupVersion.get(settings)).toBe(3);
			expect(cfgProfilesItems.get(settings)).toHaveProperty("created-during-save", createdDuringSave);
			await settings.flush();

			expect(settings.getModelRole("default")).toBe("google/latest");
			expect(cfgDefaultThinkingLevel.get(settings)).toBe(Effort.High);
			const reader = await load();
			expect(cfgProfilesActive.get(reader)).toBe("latest");
			expect(cfgSetupVersion.get(reader)).toBe(3);
			expect(cfgProfilesItems.get(reader)).toHaveProperty("created-during-save", createdDuringSave);
			expect(reader.getModelRole("default")).toBe("google/latest");
		} finally {
			releaseSave.resolve();
			openSpy.mockRestore();
		}
	});

	it("reloadFromDisk synchronizes same-profile models but never adopts another active identity", async () => {
		const work = { modelRoles: { default: "anthropic/work" }, defaultThinkingLevel: "medium" };
		const workUpdated = { modelRoles: { default: "anthropic/work-new" }, defaultThinkingLevel: "high" };
		const other = { modelRoles: { default: "openai/other" }, defaultThinkingLevel: "low" };
		const settings = await load();
		settings.setProfileItem("work", work);
		settings.setProfileItem("other", other);
		settings.activateProfile("work", work);
		await settings.flush();
		settings.cancelPendingSaves();
		rewriteConfig(config => {
			config.profiles.items.work = workUpdated;
			config.profiles.active = "other";
			config.modelRoles = other.modelRoles;
			config.defaultThinkingLevel = other.defaultThinkingLevel;
		});

		const notifications: string[][] = [];
		const unsubscribe = onSettingsSynchronized((source, changedPaths) => {
			if (source === settings) notifications.push([...changedPaths]);
		});
		try {
			await settings.reloadFromDisk();
			expect(cfgProfilesActive.get(settings)).toBe("work");
			expect(settings.getModelRole("default")).toBe("anthropic/work-new");
			expect(cfgDefaultThinkingLevel.get(settings)).toBe(Effort.High);
			expect(notifications).toHaveLength(1);
			expect(notifications[0]).not.toContain("profiles.active");
			expect(notifications[0]).toEqual(expect.arrayContaining(["modelRoles", "defaultThinkingLevel"]));
		} finally {
			unsubscribe();
		}
	});

	it("keeps an explicit local activation selected after persistence", async () => {
		const settings = await load();
		settings.setProfileItem("old", {
			modelRoles: { default: "anthropic/old" },
			defaultThinkingLevel: "medium",
		});
		const target = {
			modelRoles: { default: "openai/target" },
			defaultThinkingLevel: "high",
		};
		settings.setProfileItem("target", target);
		cfgProfilesActive.set(settings, "old");
		await settings.flush();

		settings.activateProfile("target", target);
		await settings.flush();
		expect(cfgProfilesActive.get(settings)).toBe("target");
		expect(settings.getModelRole("default")).toBe("openai/target");
	});

	it("keeps concurrent local activations isolated while last flush sets startup default", async () => {
		const seed = await load();
		const old = { modelRoles: { default: "anthropic/old" }, defaultThinkingLevel: "medium" };
		const target = { modelRoles: { default: "openai/target" }, defaultThinkingLevel: "high" };
		const winner = { modelRoles: { default: "anthropic/winner" }, defaultThinkingLevel: "low" };
		seed.setProfileItem("old", old);
		seed.setProfileItem("target", target);
		seed.setProfileItem("winner", winner);
		cfgProfilesActive.set(seed, "old");
		await seed.flush();

		const stale = await load();
		const concurrent = await load();
		stale.activateProfile("target", target);
		concurrent.activateProfile("winner", winner);
		await concurrent.flush();

		let synchronizations = 0;
		const unsubscribe = onSettingsSynchronized(source => {
			if (source === stale) synchronizations++;
		});
		try {
			await stale.flush();
			expect(cfgProfilesActive.get(stale)).toBe("target");
			expect(stale.getModelRole("default")).toBe("openai/target");
			expect(synchronizations).toBe(0);

			await concurrent.syncFromDisk();
			expect(cfgProfilesActive.get(concurrent)).toBe("winner");
			expect(concurrent.getModelRole("default")).toBe("anthropic/winner");

			const reader = await load();
			expect(cfgProfilesActive.get(reader)).toBe("target");
		} finally {
			unsubscribe();
		}
	});

	it("keeps every live peer pinned when its selected definition is deleted", async () => {
		const seed = await load();
		seed.setProfileItem("selected", {
			modelRoles: { default: "anthropic/selected" },
			defaultThinkingLevel: "low",
		});
		seed.setProfileItem("zeta", {
			modelRoles: { default: "anthropic/zeta" },
			defaultThinkingLevel: "medium",
		});
		seed.setProfileItem("alpha", {
			modelRoles: { default: "openai/alpha" },
			defaultThinkingLevel: "high",
		});
		seed.activateProfile("selected", {
			modelRoles: { default: "anthropic/selected" },
			defaultThinkingLevel: "low",
		});
		await seed.flush();

		const deleter = await load();
		const peer = await load();
		cfgModelRoles.override(peer, { default: "google/gemini-stale" });

		deleter.deleteProfileItem("selected");
		await deleter.flush();
		await peer.syncFromDisk();
		expect(cfgProfilesActive.get(peer)).toBe("selected");
		expect(peer.getModelRole("default")).toBe("google/gemini-stale");
		expect(cfgProfilesItems.get(peer)).toHaveProperty("selected");

		peer.setModelRole("advisor", "anthropic/advisor-after-delete");
		await peer.flush();
		const disk = YAML.parse(fsSync.readFileSync(path.join(dir, "config.yml"), "utf8")) as Record<string, any>;
		expect(disk.profiles.items).not.toHaveProperty("selected");
		const reader = await load();
		expect(cfgProfilesActive.get(reader)).toBe("selected");
		expect(reader.getModelRole("advisor")).toBe("anthropic/advisor-after-delete");
	});

	it("synchronizes inactive-profile deletion without changing the active profile", async () => {
		const seed = await load();
		seed.setProfileItem("active", SNAP);
		seed.setProfileItem("inactive", {
			modelRoles: { default: "openai/inactive" },
			defaultThinkingLevel: "low",
		});
		cfgProfilesActive.set(seed, "active");
		cfgModelRoles.set(seed, { ...SNAP.modelRoles });
		await seed.flush();

		const deleter = await load();
		const peer = await load();
		deleter.deleteProfileItem("inactive");
		await deleter.flush();

		await waitFor(() => !("inactive" in cfgProfilesItems.get(peer)));
		expect(cfgProfilesActive.get(peer)).toBe("active");
		expect(cfgModelRoles.get(peer)).toEqual(SNAP.modelRoles);
	});
});
