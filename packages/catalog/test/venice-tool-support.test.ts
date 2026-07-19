/**
 * Regression: Venice reports per-model function-calling support under
 * `model_spec.capabilities.supportsFunctionCalling`, but discovery ignored it.
 * Models Venice flags without tool support — the `e2ee-*` end-to-end-encrypted
 * and several `-uncensored` variants (e.g. `e2ee-qwen3-6-35b-a3b-uncensored-p`),
 * plus `hermes-3-llama-3.1-405b` — 400 with `tools is not supported by this
 * model` when omp sends a native `tools` array. Discovery now maps
 * `supportsFunctionCalling: false` → `supportsTools: false` so the agent routes
 * them through a prompted (in-band) tool dialect instead of the native API.
 */
import { describe, expect, it } from "bun:test";
import { createModelManager } from "@oh-my-pi/pi-catalog/model-manager";
import { veniceModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models";
import type { FetchImpl, Model } from "@oh-my-pi/pi-catalog/types";

function mockVeniceModels(entries: Array<Record<string, unknown>>): FetchImpl {
	return async () =>
		new Response(JSON.stringify({ object: "list", data: entries }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
}

function veniceEntry(id: string, supportsFunctionCalling: boolean) {
	return {
		id,
		object: "model",
		model_spec: {
			availableContextTokens: 100000,
			capabilities: {
				supportsFunctionCalling,
				supportsReasoning: false,
			},
		},
	};
}

describe("venice tool-support discovery", () => {
	it("marks Venice models without function-calling as supportsTools:false", async () => {
		const fetchMock = mockVeniceModels([
			veniceEntry("qwen-3-6-plus", true),
			veniceEntry("e2ee-qwen3-6-35b-a3b-uncensored-p", false),
			veniceEntry("hermes-3-llama-3.1-405b", false),
		]);

		const manager = createModelManager(veniceModelManagerOptions({ apiKey: "vapi_test", fetch: fetchMock }));
		const { models } = await manager.refresh("online");
		const byId = new Map(models.map(m => [m.id, m as Model<"openai-completions">]));

		expect(byId.get("e2ee-qwen3-6-35b-a3b-uncensored-p")?.supportsTools).toBe(false);
		expect(byId.get("hermes-3-llama-3.1-405b")?.supportsTools).toBe(false);
		// Tool-capable models are left unmarked (default tool-capable) — never forced false.
		expect(byId.get("qwen-3-6-plus")?.supportsTools).not.toBe(false);
	});
});
