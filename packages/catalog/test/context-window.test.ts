import { expect, test } from "bun:test";
import {
	clampCodexContextWindow,
	clampsContextOverride,
	codexOverrideCeiling,
	resolveMaxContextWindow,
} from "@oh-my-pi/pi-catalog/compat/context-window";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import type { ModelSpec, Provider } from "@oh-my-pi/pi-catalog/types";
import { buildModel } from "../src/build";
function bundledAstra() {
	const astra = getBundledModels("openai-codex").find(model => model.id === "gpt-6-astra");
	if (!astra) throw new Error("Expected bundled Astra model");
	return astra;
}

function bundledLegacy() {
	const legacy = getBundledModels("openai-codex").find(model => model.id === "gpt-5.5");
	if (!legacy) throw new Error("Expected bundled legacy Codex model");
	return legacy;
}

function resellerDeepSeek(id: string, provider: string, contextWindow: number) {
	const spec: ModelSpec<"openai-completions"> = {
		id,
		name: id,
		api: "openai-completions",
		provider: provider as Provider,
		baseUrl: "https://example.test/v1",
		// Reproduce thin OpenAI-compatible discovery: it knows the model reasons
		// but omits/denies the effort capability unless curated policy restores it.
		compat: { supportsReasoningEffort: false },
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 64_000,
	};
	return buildModel(spec);
}

test("corrects a stale live maximum up to the curated window", () => {
	const astra = bundledAstra();
	expect(resolveMaxContextWindow({ ...astra, maxContextWindow: 872_000 })).toBe(922_000);
});

test("keeps a higher live maximum above the curated window", () => {
	const astra = bundledAstra();
	expect(resolveMaxContextWindow({ ...astra, maxContextWindow: 1_200_000 })).toBe(1_200_000);
});

test("falls back to the curated window when the live maximum is missing or invalid", () => {
	const astra = bundledAstra();
	expect(resolveMaxContextWindow({ ...astra, maxContextWindow: undefined })).toBe(922_000);
	expect(resolveMaxContextWindow({ ...astra, maxContextWindow: 0 })).toBe(922_000);
	expect(resolveMaxContextWindow({ ...astra, maxContextWindow: Number.NaN })).toBe(922_000);
});

test("corrects GPT-6.1 Sol's stale 872K Codex maximum to the documented 922K input cap", () => {
	// Not bundled yet: build the row the way Codex discovery reports it.
	for (const id of ["gpt-6.1-sol", "gpt-6.1-sol-wm"]) {
		const sol = buildModel({
			id,
			name: "GPT-6.1 Sol",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272_000,
			maxContextWindow: 872_000,
			maxTokens: 128_000,
		});
		expect(sol.contextWindow).toBe(272_000);
		expect(resolveMaxContextWindow(sol)).toBe(922_000);
	}
});

test("grants Sol 6.1 extended context to new custom providers and prefixed routes", () => {
	for (const id of [
		"gpt-6.1-sol",
		"Wukong-Codex/gpt-6.1-sol",
		"智舵MaaS/openai/gpt-6.1-sol",
		"openrouter/openai/gpt-6.1-sol-wm",
	]) {
		const model = buildModel({
			...bundledAstra(),
			provider: "future-custom-provider",
			id,
			contextWindow: 128_000,
			maxContextWindow: undefined,
		});
		expect(resolveMaxContextWindow(model)).toBe(922_000);
		expect(resolveMaxContextWindow({ ...model, maxContextWindow: 1_200_000 })).toBe(1_200_000);
	}
});

test("does not infer the Sol 6.1 ceiling for narrower deployments or other model lines", () => {
	for (const id of ["azure/gpt-6.1-sol-2026-09-29-private", "gpt-6.1-luna", "gpt-6.2-sol"]) {
		const model = buildModel({
			...bundledAstra(),
			provider: "future-custom-provider",
			id,
			contextWindow: 128_000,
			maxContextWindow: undefined,
		});
		expect(resolveMaxContextWindow(model)).toBeUndefined();
	}
});

test("leaves models without a curated maximum to the live value or undefined", () => {
	const legacy = bundledLegacy();
	// No `max-context-window` rule owns this SKU, so extended-context widening
	// sees exactly what discovery reported — nothing curated is injected.
	expect(resolveMaxContextWindow({ ...legacy, maxContextWindow: 640_000 })).toBe(640_000);
	expect(resolveMaxContextWindow({ ...legacy, maxContextWindow: undefined })).toBeUndefined();
	expect(resolveMaxContextWindow({ ...legacy, maxContextWindow: 0 })).toBeUndefined();
	expect(resolveMaxContextWindow({ ...legacy, maxContextWindow: Number.NaN })).toBeUndefined();
});

test("clamps Codex overrides to the stale-aware ceiling", () => {
	const astra = bundledAstra();
	// Stale 872K server maximum: the curated 922K input cap is the ceiling.
	expect(codexOverrideCeiling({ ...astra, maxContextWindow: 872_000 })).toBe(922_000);
	expect(clampCodexContextWindow({ ...astra, maxContextWindow: 872_000 }, 2_000_000)).toBe(922_000);
	// Fitting requests pass through untouched.
	expect(clampCodexContextWindow({ ...astra, maxContextWindow: 872_000 }, 400_000)).toBe(400_000);
	// A higher live maximum still wins as the ceiling.
	expect(clampCodexContextWindow({ ...astra, maxContextWindow: 1_200_000 }, 2_000_000)).toBe(1_200_000);
});

test("never clamps below the working window on a stale-low maximum", () => {
	const legacy = bundledLegacy();
	// 128K base with a 64K advertised maximum: the ceiling is discredited,
	// so an explicit override falls back to the working window.
	const stale = { ...legacy, contextWindow: 128_000, maxContextWindow: 64_000 };
	expect(codexOverrideCeiling(stale)).toBe(64_000);
	expect(clampCodexContextWindow(stale, 200_000)).toBe(128_000);
	expect(clampCodexContextWindow(stale, 100_000)).toBe(100_000);
});

test("leaves models without a ceiling unclamped", () => {
	const legacy = bundledLegacy();
	expect(codexOverrideCeiling({ ...legacy, maxContextWindow: undefined })).toBeUndefined();
	expect(clampCodexContextWindow({ ...legacy, maxContextWindow: undefined }, 2_000_000)).toBe(2_000_000);
});

test("reads the override-clamp contract from KDL policy, not provider ids", () => {
	const astra = bundledAstra();
	const legacy = bundledLegacy();
	// Provider-wide Codex semantics: every Codex SKU clamps, on any route.
	expect(clampsContextOverride(astra)).toBe(true);
	expect(clampsContextOverride({ ...legacy, maxContextWindow: 640_000 })).toBe(true);
	expect(clampsContextOverride({ ...legacy, id: "gpt-5.5-wm" })).toBe(true);
	// Other providers never clamp, even with a live maximum present.
	expect(clampsContextOverride({ ...legacy, provider: "openai" })).toBe(false);
	expect(clampsContextOverride({ ...legacy, provider: "openrouter", maxContextWindow: 640_000 })).toBe(false);
});

test("grants the curated Astra ceiling to resellers that report a stale 272K default", () => {
	// The ceiling is a lineage truth, so a third-party route serving the same
	// model reaches it too — extended context previously only widened the
	// first-party Codex provider (issue: 272K shown with extended context on).
	const astra = bundledAstra();
	const resellers = [
		{ provider: "gen-api.ru-vuln", id: "gpt-6-astra" },
		{ provider: "aip-12-bitfrost", id: "Wukong/gpt-6-astra" },
		{ provider: "azure1-bitfrost", id: "openai/gpt-6-astra" },
		{ provider: "aip-15-bitfrost", id: "openrouter/openai/gpt-6-astra" },
	];
	for (const reseller of resellers) {
		const model = { ...astra, ...reseller, contextWindow: 272_000, maxContextWindow: undefined };
		expect(resolveMaxContextWindow(model)).toBe(922_000);
	}
});

test("does not widen a narrower Astra deployment that is not the 922K SKU", () => {
	// `azure/gpt-6-astra-2026-09-03-private` really is a 128K window; the
	// trailing-anchored globs must not sweep it into the 922K ceiling.
	const astra = bundledAstra();
	const narrow = {
		...astra,
		provider: "aip-1-bitfrost",
		id: "azure/gpt-6-astra-2026-09-03-private",
		contextWindow: 128_000,
		maxContextWindow: undefined,
	};
	expect(resolveMaxContextWindow(narrow)).toBeUndefined();
});

test("promotes DeepSeek V4.1 Flash to 1M across reseller spellings", () => {
	const routes = [
		{ provider: "haimaker-proxy", id: "deepseek/deepseek-v4.1-flash" },
		{ provider: "flock.io-vuln", id: "deepseek-v4.1-flash" },
		{ provider: "neuraldeep-ru-vuln", id: "deepseek-v4.1-flash" },
		{ provider: "aip2-bitfrost", id: "opencode-go/deepseek/deepseek-v4-1-flash" },
	];
	for (const route of routes) {
		const model = resellerDeepSeek(route.id, route.provider, 128_000);
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.compat.supportsReasoningEffort).toBe(true);
		expect(model.thinking).toMatchObject({
			mode: "effort",
			defaultLevel: "high",
			efforts: ["low", "high", "max"],
		});
		expect(getSupportedEfforts(model)).toEqual([Effort.Low, Effort.High, Effort.Max]);
	}
});

test("DeepSeek V4.1 Flash floor preserves larger live windows and excludes nearby variants", () => {
	expect(resellerDeepSeek("openrouter/deepseek/deepseek-v4.1-flash", "aip2-bitfrost", 1_300_000).contextWindow).toBe(
		1_300_000,
	);
	expect(resellerDeepSeek("deepseek/deepseek-v4-flash-0731", "custom", 128_000).contextWindow).toBe(128_000);
	expect(resellerDeepSeek("deepseek/deepseek-v4.1-pro", "custom", 128_000).contextWindow).toBe(128_000);
});

test("Vercel DeepSeek V4.1 Flash resolves provider efforts without a model-menu overlap", () => {
	for (const id of ["deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4-1-flash"]) {
		const model = resellerDeepSeek(id, "vercel-ai-gateway", 128_000);
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.thinking?.efforts).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]);
		expect(() => resolveMaxContextWindow(model)).not.toThrow();
	}
});
