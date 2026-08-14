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
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";

const SNAP = { modelRoles: { default: "anthropic/claude-sonnet-4" }, defaultThinkingLevel: "high" };

describe("profiles multi-instance persistence", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-profiles-"));
	});

	afterEach(async () => {
		// Close all agent.db handles so Windows can delete the temp dir.
		AgentStorage.resetInstance();
		try {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		} catch {
			// Windows can hold the sqlite handle past close(); the temp dir is OS-reclaimed.
		}
	});

	async function load() {
		const s = await Settings.loadIsolated({ agentDir: dir, cwd: dir });
		return s;
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
});
