import { describe, expect, test } from "bun:test";
import { type Api, Effort, type Model, type ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveModelOverride } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveAdvisorPickerModels } from "@oh-my-pi/pi-coding-agent/modes/components/advisor-config";
import { buildBrowserItems } from "@oh-my-pi/pi-coding-agent/modes/components/model-browser";

function model(provider: string, id: string, name = id): Model<Api> {
	return buildModel({
		provider,
		id,
		name,
		api: "openai-completions",
		baseUrl: "https://example.com/v1",
		reasoning: true,
		thinking: { mode: "effort", efforts: ["low", "high"] },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	} as ModelSpec<Api>);
}

describe("advisor configure model picker", () => {
	test("returns the live registry model for a scoped selector", () => {
		const live = model("thesparkdaily", "deepseek-v4-flash", "DeepSeek V4 Flash");
		const staleCopy = model("TheSparkDaily", "DeepSeek-V4-Flash", "Old cached name");
		const removed = model("removed-provider", "removed-model");

		const choices = resolveAdvisorPickerModels(
			[live],
			[{ model: staleCopy }, { model: removed }, { model: staleCopy }],
		);

		expect(choices).toEqual([live]);
		expect(choices[0]).toBe(live);
	});

	test("every offered selector resolves through the advisor runtime path", () => {
		const live = model("thesparkdaily", "deepseek-v4-flash", "DeepSeek V4 Flash");
		const [choice] = resolveAdvisorPickerModels([live], [{ model: live }]);
		const selector = `${buildBrowserItems([choice])[0].selector}:high`;
		const resolved = resolveModelOverride([selector], { getAvailable: () => [live] }, Settings.isolated());

		expect(selector).toBe("thesparkdaily/deepseek-v4-flash:high");
		expect(resolved.model).toBe(live);
		expect(resolved.thinkingLevel).toBe(Effort.High);
	});

	test("uses all live models when the session has no scoped model list", () => {
		const live = [model("one", "a"), model("two", "b")];
		expect(resolveAdvisorPickerModels(live, [])).toBe(live);
	});
});
