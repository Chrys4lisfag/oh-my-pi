/**
 * Regression: a provider whose discovery cache holds ZERO models was treated as
 * having a usable, authoritative cache, so the network fetch was skipped for
 * the whole TTL. In `/models` that shows as
 *
 *   clawn-vuln · 0 models
 *   Using cached model list from less than a minute ago. Press F5 to refresh.
 *
 * A configured provider has no bundled static catalog, so an empty cache row
 * can serve nothing at all — the only useful move is to fetch. A provider that
 * DOES have static models is different: an empty cache there means "discovery
 * added nothing to the bundled list", which is a legitimate cached answer and
 * must keep suppressing the fetch (see the anthropic expired-OAuth contract in
 * coding-agent/test/model-discovery.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { TempDir } from "@oh-my-pi/pi-utils";

function spec(id: string): ModelSpec<"openai-completions"> {
	return {
		api: "openai-completions",
		id,
		name: id,
		provider: "clawn-vuln",
		baseUrl: "https://clawn.example/v1",
		input: ["text"],
		// `isModelLike` requires an explicit boolean here or the fetched spec is
		// silently dropped by `normalizeModelList`.
		reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 4096,
		contextWindow: 128_000,
	};
}

describe("zero-model discovery cache", () => {
	let tempDir: TempDir;
	let cacheDbPath: string;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-zero-model-cache-");
		cacheDbPath = path.join(tempDir.path(), "models.db");
	});

	afterEach(() => {
		tempDir.removeSync();
	});

	it("fetches when a fresh cache holds no models and the provider has no static catalog", async () => {
		writeModelCache("clawn-vuln", Date.now() - 30_000, [], true, "", cacheDbPath);
		let fetchCalls = 0;
		const result = await resolveProviderModels<Api>(
			{
				providerId: "clawn-vuln",
				staticModels: [],
				cacheDbPath,
				cacheProviderId: "clawn-vuln",
				// The fetcher returns specs; the manager builds them.
				fetchDynamicModels: async () => {
					fetchCalls++;
					return [spec("clawn-one")] as never;
				},
			},
			"online-if-uncached",
		);

		expect(fetchCalls).toBe(1);
		expect(result.models.map(model => model.id)).toEqual(["clawn-one"]);
		expect(result.fetched).toBe(true);
	});

	it("still serves a fresh empty cache without fetching when static models exist", async () => {
		const staticModels = [buildModel(spec("bundled-one")) as Model<Api>];
		writeModelCache("clawn-vuln", Date.now() - 30_000, [], true, "", cacheDbPath);
		let fetchCalls = 0;
		const result = await resolveProviderModels<Api>(
			{
				providerId: "clawn-vuln",
				staticModels,
				cacheDbPath,
				cacheProviderId: "clawn-vuln",
				fetchDynamicModels: async () => {
					fetchCalls++;
					return [] as never;
				},
			},
			"online-if-uncached",
		);

		expect(fetchCalls).toBe(0);
		expect(result.models.map(model => model.id)).toEqual(["bundled-one"]);
	});

	it("keeps fetching on later refreshes while the empty cache stays empty", async () => {
		writeModelCache("clawn-vuln", Date.now() - 5_000, [], true, "", cacheDbPath);
		let fetchCalls = 0;
		const options = {
			providerId: "clawn-vuln",
			staticModels: [] as Model<Api>[],
			cacheDbPath,
			cacheProviderId: "clawn-vuln",
			fetchDynamicModels: async () => {
				fetchCalls++;
				return [] as never;
			},
		};

		await resolveProviderModels<Api>(options, "online-if-uncached");
		await resolveProviderModels<Api>(options, "online-if-uncached");

		// An endpoint that keeps answering "no models" must stay retryable
		// instead of latching a cached zero for the TTL.
		expect(fetchCalls).toBe(2);
	});
});
