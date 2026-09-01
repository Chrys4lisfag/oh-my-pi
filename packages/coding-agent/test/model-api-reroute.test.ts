/**
 * Re-routing one discovered model onto another wire API needs a `models:` entry
 * and nothing else — every other field stays inherited from discovery.
 *
 * This is the supported path (no `api` in `modelOverrides`): OpenAI-compatible
 * aggregators list every id on `/v1/models` but serve some only on
 * `/v1/responses` or `/v1/messages`, and an operator must not have to restate
 * context window, cost, modality, or thinking metadata to move one of them.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

const DISCOVERY_URL = "https://proxy.example.test/v1/models";

const discoveryFetch = ((input: unknown) => {
	if (String(input) !== DISCOVERY_URL) throw new Error(`Unexpected URL: ${String(input)}`);
	return Promise.resolve(
		new Response(
			JSON.stringify({
				data: [
					{ id: "openai/gpt-5.6-sol", context_length: 1_050_000 },
					{ id: "gemini/gemini-3.5-flash", context_length: 1_000_000 },
				],
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		),
	);
}) as unknown as typeof fetch;

function writeConfig(dir: string, modelLines: string[]): string {
	const file = path.join(dir, "models.yml");
	fs.writeFileSync(
		file,
		[
			"providers:",
			"  probe-proxy:",
			'    baseUrl: "https://proxy.example.test/v1"',
			"    api: openai-completions",
			"    auth: none",
			"    discovery:",
			"      type: openai-models-list",
			...modelLines,
		].join("\n"),
	);
	return file;
}

describe("models entry api re-route", () => {
	test("flips one model's wire API and inherits the rest from discovery", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "api-reroute-"));
		const auth = await AuthStorage.create(path.join(dir, "auth.db"));
		const file = writeConfig(dir, [
			"    models:",
			'      - id: "openai/gpt-5.6-sol"',
			"        api: openai-responses",
		]);

		const registry = new ModelRegistry(auth, file, { fetch: discoveryFetch });
		await registry.refreshProvider("probe-proxy");

		const sol = registry.find("probe-proxy", "openai/gpt-5.6-sol");
		const sibling = registry.find("probe-proxy", "gemini/gemini-3.5-flash");

		expect(sol?.api).toBe("openai-responses");
		// Nothing was restated in the entry, yet discovery/reference metadata survives.
		expect(sol?.contextWindow).toBe(1_050_000);
		expect(sol?.maxTokens).toBeGreaterThan(0);
		expect(sol?.baseUrl).toBe("https://proxy.example.test/v1");
		expect(sol?.reasoning).toBe(true);
		expect(sol?.thinking?.efforts?.length ?? 0).toBeGreaterThan(0);
		// Siblings stay on the provider-level wire.
		expect(sibling?.api).toBe("openai-completions");
		expect(sibling?.contextWindow).toBe(1_000_000);
		auth.close();
	}, 60_000);

	test("modelOverrides cannot re-route the wire API", async () => {
		// `api` is not part of the override surface, so it is ignored — this is the
		// reason the `models:` entry above is the supported path.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "api-reroute-override-"));
		const auth = await AuthStorage.create(path.join(dir, "auth.db"));
		const file = writeConfig(dir, [
			"    modelOverrides:",
			'      "openai/gpt-5.6-sol":',
			"        api: openai-responses",
			"        maxTokens: 4096",
		]);

		const registry = new ModelRegistry(auth, file, { fetch: discoveryFetch });
		await registry.refreshProvider("probe-proxy");

		const sol = registry.find("probe-proxy", "openai/gpt-5.6-sol");
		expect(sol?.api).toBe("openai-completions");
		// Declared override fields still apply; only `api` is out of scope.
		expect(sol?.maxTokens).toBe(4096);
		auth.close();
	}, 60_000);
});
