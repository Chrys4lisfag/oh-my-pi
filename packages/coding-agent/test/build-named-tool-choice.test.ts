import { describe, expect, it } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildNamedToolChoice } from "@oh-my-pi/pi-coding-agent/utils/tool-choice";

function model<A extends Api>(api: A): Model<A> {
	return {
		id: "test-model",
		name: "test-model",
		api,
		provider: "test",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8192,
	} as Model<A>;
}

describe("buildNamedToolChoice", () => {
	it("returns undefined when model is missing", () => {
		expect(buildNamedToolChoice("yield", undefined)).toBeUndefined();
	});

	it("emits structured { type: 'tool', name } for Anthropic", () => {
		expect(buildNamedToolChoice("yield", model("anthropic-messages"))).toEqual({
			type: "tool",
			name: "yield",
		});
	});

	it("emits structured { type: 'function', name } for OpenAI variants", () => {
		for (const api of [
			"openai-completions",
			"openai-responses",
			"openai-codex-responses",
			"azure-openai-responses",
		] as const) {
			expect(buildNamedToolChoice("yield", model(api))).toEqual({
				type: "function",
				name: "yield",
			});
		}
	});

	it("emits structured { type: 'tool', name } for ALL Google APIs (regression: not bare 'required')", () => {
		// Regression for 400 INVALID_ARGUMENT "too many states for serving" failures
		// observed on gemini-3.1-pro-preview when subagent yield enforcement
		// returned bare "required" instead of a named-tool form. Gemini's
		// constraint engine compiles a grammar over every declared function
		// when no allowedFunctionNames filter is given; on subagent stacks
		// aggregating ~270 MCP tools the state machine exceeds serving limits.
		for (const api of ["google-generative-ai", "google-gemini-cli", "google-vertex"] as const) {
			expect(buildNamedToolChoice("yield", model(api))).toEqual({
				type: "tool",
				name: "yield",
			});
		}
	});

	it("falls back to bare 'required' for ollama-chat (which has no named-tool form)", () => {
		expect(buildNamedToolChoice("yield", model("ollama-chat"))).toBe("required");
	});

	it("returns undefined for unknown APIs", () => {
		expect(buildNamedToolChoice("yield", model("cursor-agent"))).toBeUndefined();
	});
});
