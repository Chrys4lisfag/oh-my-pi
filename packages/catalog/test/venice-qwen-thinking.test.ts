/**
 * Regression: sending a Qwen model on the Venice provider
 * (`api.venice.ai`) returned `400 {"issues":[{"code":"unrecognized_keys",
 * "keys":["enable_thinking"]}]}` on every turn.
 *
 * Root cause: Venice's chat-completions schema is `additionalProperties: false`
 * and rejects unknown top-level keys. `buildOpenAICompat` picked
 * `thinkingFormat: "qwen"` from the `qwen*` id for any host that wasn't NVIDIA
 * NIM or Fireworks, so Venice-hosted Qwen turns shipped a top-level
 * `enable_thinking` field — the same failure class as NVIDIA NIM (#2299).
 *
 * Fix: register `venice` as a known host and route its Qwen models to the
 * standard `"openai"` reasoning_effort dialect (mirroring the Fireworks Qwen
 * carve-out) so no `enable_thinking` reaches the wire.
 */
import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { buildOpenAICompat } from "@oh-my-pi/pi-catalog/compat/openai";
import type { FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";

function veniceQwenSpec(): ModelSpec<"openai-completions"> {
	return {
		api: "openai-completions",
		id: "qwen-3-6-plus",
		name: "Qwen 3.6 Plus",
		provider: "venice",
		baseUrl: "https://api.venice.ai/api/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 64000,
		contextWindow: 262144,
		reasoning: true,
	};
}

function sseDoneResponse(): Response {
	return new Response("data: [DONE]\n\n", {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("Venice qwen thinking format", () => {
	it("routes Venice-hosted qwen models to the openai format (not top-level enable_thinking)", () => {
		expect(buildOpenAICompat(veniceQwenSpec()).thinkingFormat).toBe("openai");
	});

	it("keeps non-Venice qwen models (Alibaba DashScope) on the top-level enable_thinking format", () => {
		const dashscope: ModelSpec<"openai-completions"> = {
			api: "openai-completions",
			id: "qwen3-coder-plus",
			name: "Qwen3 Coder Plus",
			provider: "alibaba-coding-plan",
			baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			maxTokens: 8192,
			contextWindow: 131072,
			reasoning: true,
		};
		expect(buildOpenAICompat(dashscope).thinkingFormat).toBe("qwen");
	});

	it("never emits enable_thinking (top-level or chat_template_kwargs) on the Venice wire", async () => {
		const model = buildModel(veniceQwenSpec());
		const captured: { body: string | null } = { body: null };
		const fetchMock: FetchImpl = async (_input, init) => {
			captured.body = typeof init?.body === "string" ? init.body : null;
			return sseDoneResponse();
		};
		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		};
		const stream = streamOpenAICompletions(model as Model<"openai-completions">, context, {
			apiKey: "vapi-test",
			reasoning: "high",
			fetch: fetchMock,
		});
		for await (const _ of stream) {
			// drain
		}

		expect(captured.body).not.toBeNull();
		const parsed = JSON.parse(captured.body ?? "{}") as Record<string, unknown>;
		expect(parsed.enable_thinking).toBeUndefined();
		expect(parsed.chat_template_kwargs).toBeUndefined();
	});
});
