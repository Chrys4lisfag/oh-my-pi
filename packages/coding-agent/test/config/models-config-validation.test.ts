import { describe, expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { validateProviderConfiguration } from "@oh-my-pi/pi-coding-agent/config/models-config";
import { ModelsConfigSchema } from "@oh-my-pi/pi-coding-agent/config/models-config-schema";

const models = [{ id: "grok-4", api: "openai-completions" as const }];
const baseUrl = "https://api.example.invalid/v1";

describe("validateProviderConfiguration (models-config auth)", () => {
	test("auth: oauth allows custom models without apiKey", () => {
		expect(() =>
			validateProviderConfiguration("xai-oauth", { baseUrl, auth: "oauth", models }, "models-config"),
		).not.toThrow();
	});

	test("auth: none allows custom models without apiKey", () => {
		expect(() =>
			validateProviderConfiguration("local", { baseUrl, auth: "none", models }, "models-config"),
		).not.toThrow();
	});

	test("default auth (apiKey) still requires apiKey for custom models", () => {
		expect(() => validateProviderConfiguration("custom", { baseUrl, models }, "models-config")).toThrow(
			'Provider custom: "apiKey" is required when defining custom models unless auth is "none" or "oauth".',
		);
	});

	test("explicit auth: apiKey with apiKey set passes", () => {
		expect(() =>
			validateProviderConfiguration(
				"custom",
				{ baseUrl, auth: "apiKey", apiKey: "sk-test", models },
				"models-config",
			),
		).not.toThrow();
	});
});

describe("models config discovery overrides", () => {
	test("accepts a separate OpenAI-compatible discovery base URL", () => {
		const config: typeof ModelsConfigSchema.infer = {
			providers: {
				split: {
					baseUrl: "https://example.com/v1/oneapi/proxy/11",
					apiKey: "TEST_KEY",
					api: "openai-completions",
					discovery: { type: "openai-models-list", baseUrl: "https://example.com/v1", auth: "none" },
				},
			},
		};
		const parsed = ModelsConfigSchema(config);
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect(parsed.providers?.split?.discovery?.baseUrl).toBe("https://example.com/v1");
			expect(parsed.providers?.split?.discovery?.auth).toBe("none");
		}
	});

	test("rejects empty or unsupported discovery base URL overrides", () => {
		for (const discovery of [
			{ type: "openai-models-list", baseUrl: "" },
			{ type: "ollama", baseUrl: "https://discovery.example.com" },
		]) {
			const parsed = ModelsConfigSchema({
				providers: {
					bad: {
						baseUrl: "https://inference.example.com/v1",
						apiKey: "TEST_KEY",
						api: "openai-completions",
						discovery,
					},
				},
			});
			expect(parsed instanceof type.errors).toBe(true);
		}
	});
});
