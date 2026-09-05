/**
 * Regression (`clawn-vuln · 0 models` + "Using cached model list from less than
 * a minute ago. Press F5 to refresh."): a configured provider whose discovery
 * cache row holds zero models was reported as `cached`, so the hub advertised a
 * cached list it did not have and the only recovery was a manual refresh.
 *
 * Contract: an empty cache row can serve nothing, so the provider stays
 * retryable — `idle`, not `cached` — and the hub says so.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("zero-model discovery cache recovery", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelsYmlPath: string;
	let cacheDbPath: string;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-zero-model-recovery-");
		modelsYmlPath = path.join(tempDir.path(), "models.yml");
		cacheDbPath = path.join(tempDir.path(), "models.db");
		await Bun.write(
			modelsYmlPath,
			[
				"providers:",
				"  clawn-vuln:",
				'    baseUrl: "https://clawn.example/v1"',
				"    api: openai-completions",
				"    auth: none",
				"    discovery:",
				"      type: openai-models-list",
				"",
			].join("\n"),
		);
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	});

	afterEach(() => {
		authStorage?.close();
		tempDir.removeSync();
	});

	function modelsResponse(ids: string[]): Response {
		return new Response(JSON.stringify({ data: ids.map(id => ({ id, object: "model" })) }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}

	it("keeps a provider retryable after discovery returns an empty catalog", async () => {
		let served: string[] = [];
		let calls = 0;
		const registry = new ModelRegistry(authStorage, modelsYmlPath, {
			cacheDbPath,
			fetch: (async () => {
				calls++;
				return modelsResponse(served);
			}) as unknown as typeof fetch,
		});

		// 1. The endpoint answers with an empty catalog: a real fetch happened, so
		//    the state is `empty` (not `cached`) and a cache row now exists.
		await registry.refresh("online");
		expect(calls).toBeGreaterThan(0);
		expect(registry.getProviderDiscoveryState("clawn-vuln")?.status).toBe("empty");

		// 2. Reopening the hub hydrates offline. The zero-model row can serve
		//    nothing, so it must NOT be advertised as a cached list — that is the
		//    "0 models · Using cached model list from less than a minute ago" bug.
		await registry.refresh("offline");
		// The status stays `cached` by design (a fetched-empty answer is cached
		// knowledge, and `attemptedAt` must survive the offline view) — what must
		// NOT happen is serving that row as a model list, which is asserted at the
		// hub layer in model-hub.test.ts and enforced in the manager below.
		const offlineState = registry.getProviderDiscoveryState("clawn-vuln");
		expect(offlineState?.models).toEqual([]);

		// 3. The provider recovers on the next online refresh instead of waiting
		//    out the cache TTL.
		served = ["clawn-one", "clawn-two"];
		await registry.refresh("online");
		const recovered = registry.getProviderDiscoveryState("clawn-vuln");
		expect(recovered?.status).toBe("ok");
		expect(recovered?.models.sort()).toEqual(["clawn-one", "clawn-two"]);
	});
});
