import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	expandDefaultRetryFallbackChains,
	findRetryFallbackCandidates,
	type RetryFallbackResolutionContext,
	resolveRetryFallbackChainKey,
} from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";

function createContext(
	chains: RetryFallbackResolutionContext["chains"],
	roles: Record<string, string> = {},
): RetryFallbackResolutionContext {
	const models = [
		getBundledModel("google", "gemini-2.5-flash"),
		getBundledModel("google-vertex", "gemini-2.5-flash"),
		getBundledModel("openrouter", "google/gemini-2.5-flash"),
		getBundledModel("openai", "gpt-4o-mini"),
	].filter(model => model !== undefined);
	return {
		chains,
		getModelRole: role => roles[role],
		modelLookup: {
			find: (provider, id) => models.find(model => model.provider === provider && model.id === id),
			hasProvider: provider => models.some(model => model.provider === provider),
		},
	};
}

describe("retry fallback selector resolution", () => {
	it("resolves chain keys by exact model, longest wildcard, role, then default", () => {
		const selector = "openrouter/google/gemini-2.5-flash";
		const exactContext = createContext(
			{
				default: ["openai/gpt-4o-mini"],
				task: ["google/gemini-2.5-flash"],
				"openrouter/*": ["openai/gpt-4o-mini"],
				"openrouter/google/*": ["google-vertex/*"],
				[selector]: ["google/gemini-2.5-flash"],
			},
			{ task: selector },
		);
		expect(resolveRetryFallbackChainKey(exactContext, selector, undefined, "task")).toBe(selector);

		const wildcardContext = createContext(
			{
				default: ["openai/gpt-4o-mini"],
				task: ["google/gemini-2.5-flash"],
				"openrouter/*": ["openai/gpt-4o-mini"],
				"openrouter/google/*": ["google-vertex/*"],
			},
			{ task: selector },
		);
		expect(resolveRetryFallbackChainKey(wildcardContext, selector, undefined, "task")).toBe("openrouter/google/*");

		const roleContext = createContext(
			{ default: ["openai/gpt-4o-mini"], task: ["google/gemini-2.5-flash"] },
			{ task: selector },
		);
		expect(resolveRetryFallbackChainKey(roleContext, selector, undefined, "task")).toBe("task");

		// The `default` chain applies with no `default` role only when the failing
		// model IS the session model — then the running model is effectively the
		// default. An unrelated failing model (subagent/advisor/role-scoped call)
		// must not borrow it.
		const defaultContext = createContext({ default: ["openai/gpt-4o-mini"] });
		const sessionModel = getBundledModel("openrouter", "google/gemini-2.5-flash");
		if (!sessionModel) throw new Error("expected bundled model");
		expect(resolveRetryFallbackChainKey(defaultContext, selector, sessionModel)).toBe("default");
		const unrelated = getBundledModel("openai", "gpt-4o-mini");
		expect(resolveRetryFallbackChainKey(defaultContext, selector, unrelated)).toBeUndefined();
		expect(resolveRetryFallbackChainKey(defaultContext, selector)).toBeUndefined();
	});

	it("does not let a later shared-assignment role steal the default chain", () => {
		const selector = "openrouter/google/gemini-2.5-flash";
		const context = createContext(
			{
				vision: ["openai/gpt-4o-mini"],
				default: ["google/gemini-2.5-flash"],
			},
			{ default: selector, vision: selector },
		);
		expect(resolveRetryFallbackChainKey(context, selector)).toBe("default");
		expect(resolveRetryFallbackChainKey(context, selector, undefined, "default")).toBe("default");
		expect(resolveRetryFallbackChainKey(context, selector, undefined, "vision")).toBe("vision");
	});

	it("uses a hinted role chain when its unqualified primary cannot resolve", () => {
		const context = createContext({ task: ["openai/gpt-4o-mini"] });
		const chainKey = resolveRetryFallbackChainKey(context, "missing-model:high", undefined, "task");
		expect(chainKey).toBe("task");
		if (!chainKey) throw new Error("Expected hinted role fallback chain");
		expect(
			findRetryFallbackCandidates(context, chainKey, "missing-model:high", undefined, {
				allowMissingPrimary: true,
			}),
		).toEqual([
			{
				raw: "openai/gpt-4o-mini",
				provider: "openai",
				id: "gpt-4o-mini",
				thinkingLevel: undefined,
			},
		]);
	});

	it("stops a role chain when its primary assignment is removed at runtime", () => {
		const context = createContext({
			slow: ["google/gemini-2.5-flash", "openai/gpt-4o-mini"],
		});
		expect(findRetryFallbackCandidates(context, "slow", "google/gemini-2.5-flash")).toEqual([]);
	});

	it("expands wildcard candidates from the current selector", () => {
		const selector = "openrouter/google/gemini-2.5-flash";
		const context = createContext({ "openrouter/google/*": ["google-vertex/*"] });
		const candidates = findRetryFallbackCandidates(context, "openrouter/google/*", selector);
		expect(candidates).toEqual([
			{
				raw: "google-vertex/gemini-2.5-flash",
				provider: "google-vertex",
				id: "gemini-2.5-flash",
				thinkingLevel: undefined,
			},
		]);
	});

	it("carries per-entry thinking levels while bare entries inherit", () => {
		const context = createContext({ default: ["openai/gpt-4o-mini:low", "google/gemini-2.5-flash"] });
		const candidates = findRetryFallbackCandidates(context, "default", "openai/gpt-4o-mini");
		expect(candidates.map(candidate => candidate.raw)).toEqual(["openai/gpt-4o-mini:low", "google/gemini-2.5-flash"]);
		expect(candidates[0]?.thinkingLevel).toBe(ThinkingLevel.Low);
		// Bare entries carry no level so the failing turn's effort applies at switch time.
		expect(candidates[1]?.thinkingLevel).toBeUndefined();
	});

	it("never inherits the default chain onto other roles", () => {
		// Chains are strict: a role gets a chain only when configured by name.
		// Inheritance meant any model that happened to be a role's primary
		// silently gained the `default` chain's target — an unconfigured
		// `antigravity-native/gemini-3.8-flash` was answered with the default
		// chain's `azure1-bitfrost/openai/gpt-6-astra`.
		const defaultChain = ["openai/gpt-4o-mini"];
		const expanded = expandDefaultRetryFallbackChains({ default: defaultChain, slow: ["google/gemini-2.5-flash"] }, [
			"default",
			"task",
			"slow",
		]);
		expect(expanded.task).toBeUndefined();
		expect(expanded.slow).toEqual(["google/gemini-2.5-flash"]);
		expect(expanded.default).toEqual(defaultChain);
	});
});
