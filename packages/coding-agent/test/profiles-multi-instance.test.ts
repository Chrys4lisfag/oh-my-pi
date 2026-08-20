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

describe("profiles multi-instance persistence", () => {
	let dir: string;

	beforeEach(async () => {
		resetSettingsForTest();
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-profiles-"));
	});

	afterEach(async () => {
		AgentStorage.resetInstance();
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
		const items = reader.get("profiles.items") as Record<string, unknown>;
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
		const items = reader.get("profiles.items") as Record<string, unknown>;
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
		const items = reader.get("profiles.items") as Record<string, unknown>;
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
		expect(reader.get("profiles.items")).toEqual({});
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
		expect(reader.get("profiles.items")).toEqual({});
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
		expect(reader.get("profiles.items")).toEqual({ shared: replacement });
	});

	it("does not persist a stale active marker for a concurrently deleted profile", async () => {
		const seed = await load();
		seed.setProfileItem("shared", SNAP);
		seed.set("profiles.active", "shared");
		await seed.flush();

		const stale = await load();
		const deleter = await load();
		deleter.deleteProfileItem("shared");
		deleter.set("profiles.active", "");
		await deleter.flush();

		stale.setProfileItem("shared", {
			modelRoles: { default: "xai-oauth/grok-4.5" },
			defaultThinkingLevel: "auto",
		});
		stale.set("profiles.active", "shared");
		await stale.flush();

		const reader = await load();
		expect(reader.get("profiles.items")).toEqual({});
		expect(reader.get("profiles.active")).toBe("");
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
		expect(reader.get("profiles.items")).toEqual({ new: edited });
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
		expect(reader.get("profiles.items")).toEqual({});
	});

	it("does not overwrite a rename destination concurrently created by another instance", async () => {
		const seed = await load();
		seed.setProfileItem("old", SNAP);
		await seed.flush();

		const stale = await load();
		const creator = await load();
		const concurrent = {
			modelRoles: { default: "openai-codex/gpt-5.6" },
			defaultThinkingLevel: "medium",
		};
		creator.setProfileItem("new", concurrent);
		await creator.flush();
		stale.renameProfileItem("old", "new", SNAP, false);
		await stale.flush();

		const reader = await load();
		expect(reader.get("profiles.items")).toEqual({ old: SNAP, new: concurrent });
	});
	it("activates the freshest target snapshot without writing a stale copy", async () => {
		const old = { modelRoles: { default: "anthropic/old" }, defaultThinkingLevel: "low" };
		const staleTarget = { modelRoles: { default: "anthropic/stale" }, defaultThinkingLevel: "medium" };
		const freshTarget = { modelRoles: { default: "openai/fresh" }, defaultThinkingLevel: "high" };
		const seed = await load();
		seed.setProfileItem("old", old);
		seed.setProfileItem("target", staleTarget);
		seed.set("profiles.active", "old");
		seed.set("modelRoles", old.modelRoles);
		await seed.flush();

		const stale = await load();
		rewriteConfig(config => {
			config.profiles.items.target = freshTarget;
		});
		stale.activateProfile("target", staleTarget);
		await stale.flush();

		const reader = await load();
		expect(reader.get("profiles.items").target).toEqual(freshTarget);
		expect(reader.get("profiles.active")).toBe("target");
		expect(reader.get("modelRoles")).toEqual(freshTarget.modelRoles);
		expect(reader.get("defaultThinkingLevel")).toBe(Effort.High);
	});

	it("renames the freshest source without overwriting a concurrently changed active marker", async () => {
		const other = { modelRoles: { default: "openai/other" }, defaultThinkingLevel: "high" };
		const fresh = { modelRoles: { default: "openai/fresh-source" }, defaultThinkingLevel: "medium" };
		const seed = await load();
		seed.setProfileItem("old", SNAP);
		seed.setProfileItem("other", other);
		seed.set("profiles.active", "old");
		seed.set("modelRoles", SNAP.modelRoles);
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
		expect(reader.get("profiles.items")).toEqual({ new: fresh, other });
		expect(reader.get("profiles.active")).toBe("other");
		expect(reader.get("modelRoles")).toEqual(other.modelRoles);
	});

	it("does not overwrite a concurrently changed active marker when deleting stale active state", async () => {
		const other = { modelRoles: { default: "openai/other" }, defaultThinkingLevel: "high" };
		const seed = await load();
		seed.setProfileItem("selected", SNAP);
		seed.setProfileItem("other", other);
		seed.set("profiles.active", "selected");
		seed.set("modelRoles", SNAP.modelRoles);
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
		expect(reader.get("profiles.items")).toEqual({ other });
		expect(reader.get("profiles.active")).toBe("other");
		expect(reader.get("modelRoles")).toEqual(other.modelRoles);
	});

	it("preserves unrelated explicit overrides and retires profile-owned slots after final deletion", async () => {
		const seed = await load();
		seed.setProfileItem("only", SNAP);
		seed.set("profiles.active", "only");
		seed.set("modelRoles", SNAP.modelRoles);
		seed.set("defaultThinkingLevel", Effort.High);
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
		expect(peer.getModelRole("default")).toBe("runtime/default");
		expect(peer.getModelRole("advisor")).toBe("runtime/advisor");
		expect(peer.getModelRole("smol")).toBe("project/smol");
		expect(peer.get("defaultThinkingLevel")).toBe(Effort.XHigh);
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
		seed.set("profiles.active", "work");
		seed.set("modelRoles", { default: "anthropic/initial" });
		await seed.flush();

		const writer = await load();
		const peer = await seed.cloneForCwd(dir);

		writer.activateProfile("other", {
			modelRoles: { default: "openai/other" },
			defaultThinkingLevel: "low",
		});
		await writer.flush();
		await Bun.sleep(400);

		expect(peer.get("profiles.active")).toBe("work");
		expect(peer.getModelRole("default")).toBe("anthropic/initial");
	});

	it("keeps its active profile when an unrelated save merges another terminal's activation", async () => {
		const work = { modelRoles: { default: "anthropic/work" }, defaultThinkingLevel: "medium" };
		const other = { modelRoles: { default: "openai/other" }, defaultThinkingLevel: "low" };
		const seed = await load();
		seed.setProfileItem("work", work);
		seed.setProfileItem("other", other);
		seed.set("profiles.active", "work");
		seed.set("modelRoles", work.modelRoles);
		seed.set("defaultThinkingLevel", Effort.Medium);
		await seed.flush();

		const stale = await seed.cloneForCwd(dir);
		stale.cancelIfSessionOwned();
		const writer = await load();
		writer.activateProfile("other", other);
		await writer.flush();

		stale.set("setupVersion", 2);
		await stale.flush();

		expect(stale.get("profiles.active")).toBe("work");
		expect(stale.getModelRole("default")).toBe("anthropic/work");
		expect(stale.get("defaultThinkingLevel")).toBe(Effort.Medium);
		const reader = await load();
		expect(reader.get("setupVersion")).toBe(2);
		expect(reader.get("profiles.active")).toBe("other");
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
		seed.set("profiles.active", "work");
		seed.set("modelRoles", work.modelRoles);
		await seed.flush();

		const settings = await seed.cloneForCwd(dir);
		settings.cancelIfSessionOwned();
		const writer = await load();
		writer.activateProfile("foreign", foreign);
		await writer.flush();

		const saveEntered = Promise.withResolvers<void>();
		const releaseSave = Promise.withResolvers<void>();
		const rename = fsSync.promises.rename.bind(fsSync.promises);
		const configPath = path.join(dir, "config.yml");
		let intercepted = false;
		const renameSpy = vi.spyOn(fsSync.promises, "rename").mockImplementation(async (source, target) => {
			if (
				!intercepted &&
				String(source).endsWith(".tmp") &&
				path.normalize(String(target)) === path.normalize(configPath)
			) {
				intercepted = true;
				saveEntered.resolve();
				await releaseSave.promise;
			}
			await rename(source, target);
		});
		const createdDuringSave = {
			modelRoles: { default: "anthropic/concurrent" },
			defaultThinkingLevel: "medium",
		};
		try {
			settings.set("setupVersion", 2);
			const firstFlush = settings.flush();
			await saveEntered.promise;
			settings.activateProfile("latest", latest);
			settings.set("setupVersion", 3);
			settings.setProfileItem("created-during-save", createdDuringSave);
			releaseSave.resolve();
			await firstFlush;

			expect(settings.get("profiles.active")).toBe("latest");
			expect(settings.get("setupVersion")).toBe(3);
			expect(settings.get("profiles.items")).toHaveProperty("created-during-save", createdDuringSave);
			await settings.flush();

			expect(settings.getModelRole("default")).toBe("google/latest");
			expect(settings.get("defaultThinkingLevel")).toBe(Effort.High);
			const reader = await load();
			expect(reader.get("profiles.active")).toBe("latest");
			expect(reader.get("setupVersion")).toBe(3);
			expect(reader.get("profiles.items")).toHaveProperty("created-during-save", createdDuringSave);
			expect(reader.getModelRole("default")).toBe("google/latest");
		} finally {
			releaseSave.resolve();
			renameSpy.mockRestore();
		}
	});

	it("reconciles and notifies when reloadFromDisk adopts another active profile", async () => {
		const work = { modelRoles: { default: "anthropic/work" }, defaultThinkingLevel: "medium" };
		const other = { modelRoles: { default: "openai/other" }, defaultThinkingLevel: "low" };
		const settings = await load();
		settings.setProfileItem("work", work);
		settings.setProfileItem("other", other);
		settings.set("profiles.active", "work");
		settings.set("modelRoles", work.modelRoles);
		settings.set("defaultThinkingLevel", Effort.Medium);
		await settings.flush();
		settings.cancelPendingSaves();
		rewriteConfig(config => {
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
			expect(settings.get("profiles.active")).toBe("other");
			expect(settings.getModelRole("default")).toBe("openai/other");
			expect(settings.get("defaultThinkingLevel")).toBe(Effort.Low);
			expect(notifications).toHaveLength(1);
			expect(notifications[0]).toEqual(
				expect.arrayContaining(["profiles.active", "modelRoles", "defaultThinkingLevel"]),
			);
		} finally {
			unsubscribe();
		}
	});

	it("does not emit an external synchronization event for local activation", async () => {
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
		settings.set("profiles.active", "old");
		await settings.flush();

		let synchronizations = 0;
		const unsubscribe = onSettingsSynchronized(source => {
			if (source === settings) synchronizations++;
		});
		try {
			settings.activateProfile("target", target);
			await settings.flush();
			expect(synchronizations).toBe(0);
		} finally {
			unsubscribe();
		}
	});

	it("keeps concurrent local activations isolated while last flush sets startup default", async () => {
		const seed = await load();
		const old = { modelRoles: { default: "anthropic/old" }, defaultThinkingLevel: "medium" };
		const target = { modelRoles: { default: "openai/target" }, defaultThinkingLevel: "high" };
		const winner = { modelRoles: { default: "anthropic/winner" }, defaultThinkingLevel: "low" };
		seed.setProfileItem("old", old);
		seed.setProfileItem("target", target);
		seed.setProfileItem("winner", winner);
		seed.set("profiles.active", "old");
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
			expect(stale.get("profiles.active")).toBe("target");
			expect(stale.getModelRole("default")).toBe("openai/target");
			expect(synchronizations).toBe(0);

			await concurrent.syncFromDisk();
			expect(concurrent.get("profiles.active")).toBe("winner");
			expect(concurrent.getModelRole("default")).toBe("anthropic/winner");

			const reader = await load();
			expect(reader.get("profiles.active")).toBe("target");
		} finally {
			unsubscribe();
		}
	});

	it("autoswitches every live peer when its selected profile is deleted", async () => {
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
		seed.set("profiles.active", "selected");
		seed.set("modelRoles", { default: "anthropic/selected" });
		seed.set("defaultThinkingLevel", Effort.Low);
		await seed.flush();

		const deleter = await load();
		const peer = await load();
		peer.overrideModelRoles({ default: "google/gemini-stale" });

		deleter.deleteProfileItem("selected");
		await deleter.flush();
		await waitFor(
			() =>
				peer.get("profiles.active") === "alpha" &&
				peer.getModelRole("default") === "openai/alpha" &&
				!("selected" in peer.get("profiles.items")),
		);

		peer.setModelRole("advisor", "anthropic/advisor-after-delete");
		await peer.flush();
		const reader = await load();
		expect(reader.get("profiles.active")).toBe("alpha");
		expect(reader.get("profiles.items")).not.toHaveProperty("selected");
		expect(reader.get("modelRoles")).toEqual({
			default: "openai/alpha",
			advisor: "anthropic/advisor-after-delete",
		});
		expect(reader.get("defaultThinkingLevel")).toBe(Effort.High);
	});

	it("synchronizes inactive-profile deletion without changing the active profile", async () => {
		const seed = await load();
		seed.setProfileItem("active", SNAP);
		seed.setProfileItem("inactive", {
			modelRoles: { default: "openai/inactive" },
			defaultThinkingLevel: "low",
		});
		seed.set("profiles.active", "active");
		seed.set("modelRoles", { ...SNAP.modelRoles });
		await seed.flush();

		const deleter = await load();
		const peer = await load();
		deleter.deleteProfileItem("inactive");
		await deleter.flush();

		await waitFor(() => !("inactive" in peer.get("profiles.items")));
		expect(peer.get("profiles.active")).toBe("active");
		expect(peer.get("modelRoles")).toEqual(SNAP.modelRoles);
	});
});
