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

const SNAP = { modelRoles: { default: "anthropic/claude-sonnet-4" }, defaultThinkingLevel: "high" };

describe("profiles multi-instance persistence", () => {
	let dir: string;
	const created: Settings[] = [];

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-profiles-"));
	});

	afterEach(async () => {
		// Close each instance's agent.db handle so Windows can delete the temp dir.
		for (const s of created.splice(0)) {
			try {
				s.getStorage()?.close();
			} catch {}
		}
		try {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		} catch {
			// Windows can hold the sqlite handle past close(); the temp dir is OS-reclaimed.
		}
	});

	async function load() {
		const s = await Settings.loadIsolated({ agentDir: dir, cwd: dir });
		created.push(s);
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
});
