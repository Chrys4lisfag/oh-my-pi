import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveAutoCompactionAction } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";

function responseModel(provider: string, id: string, api: Model["api"] = "openai-responses"): Model {
	return { ...createMockModel({ provider, id }).model, api };
}

function resolveAction(settings: Settings, compactionModel: Model): "context-full" | "handoff" | "snapcompact" {
	return resolveAutoCompactionAction({
		settings: settings.getGroup("compaction"),
		compactionModel,
		strategyConfigured: settings.isConfigured("compaction.strategy"),
		reason: "threshold",
		suppressHandoff: false,
	});
}

describe("resolveAutoCompactionAction", () => {
	it("defaults OpenAI GPT and Codex response models to remote-capable context-full compaction", () => {
		const settings = Settings.isolated();
		const gpt = responseModel("openai", "gpt-test");
		const codex = responseModel("openai-codex", "gpt-codex-test", "openai-codex-responses");

		expect(settings.get("compaction.strategy")).toBe("snapcompact");
		expect(settings.isConfigured("compaction.strategy")).toBe(false);
		expect(resolveAction(settings, gpt)).toBe("context-full");
		expect(resolveAction(settings, codex)).toBe("context-full");
	});

	it("honors an explicit local snapcompact strategy for GPT models", () => {
		const settings = Settings.isolated({ "compaction.strategy": "snapcompact" });
		const gpt = responseModel("openai", "gpt-test");

		expect(settings.isConfigured("compaction.strategy")).toBe(true);
		expect(resolveAction(settings, gpt)).toBe("snapcompact");
	});

	it("honors explicit context-full even when the model has no native remote API", () => {
		const settings = Settings.isolated({ "compaction.strategy": "context-full" });
		const legacyOpenAi = createMockModel({ provider: "openai", id: "legacy-gpt-test" }).model;

		expect(resolveAction(settings, legacyOpenAi)).toBe("context-full");
	});

	it("keeps the local default for models without provider-native compaction", () => {
		const settings = Settings.isolated();
		const claude = createMockModel({ provider: "anthropic", id: "claude-test" }).model;
		const unsupportedOpenAi = createMockModel({ provider: "openai", id: "legacy-gpt-test" }).model;

		expect(resolveAction(settings, claude)).toBe("snapcompact");
		expect(resolveAction(settings, unsupportedOpenAi)).toBe("snapcompact");
	});

	it("keeps the local default when remote compaction is disabled", () => {
		const settings = Settings.isolated({ "compaction.remoteEnabled": false });
		const gpt = responseModel("openai", "gpt-test");
		const disabledModel: Model = {
			...responseModel("openai", "gpt-disabled-test"),
			remoteCompaction: { enabled: false },
		};

		expect(resolveAction(settings, gpt)).toBe("snapcompact");
		expect(resolveAction(Settings.isolated(), disabledModel)).toBe("snapcompact");
	});
});
