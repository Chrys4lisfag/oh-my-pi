/**
 * A pinned fallback chain must not outrank the failing model's OWN chain.
 *
 * `#activeRetryFallback.role` (and its advisor-local twin
 * `advisor.retryFallback.role`) is pinned at the first hop and never
 * re-resolved, while `retryFallbackChainKeys` consults the pinned chain BEFORE
 * the chain the current model owns. When the model later changes by another
 * route — `/advisor configure`, profile sync, context promotion — the pin
 * survives into a walk it no longer belongs to.
 *
 * Reported shape: an advisor configured `maiarouter-ai-vuln/deepseek/deepseek-v4-flash
 * -> [entrim-ai-vuln/…]` hit `429 Budget has been exceeded!` and fell back to
 * `oriona-vuln-bitfrost/…kimi-k3` — the first entry of the unrelated
 * `mammouth-vuln/*` chain it had been pinned to earlier — instead of its own
 * single configured entry.
 *
 * Contract: a pin is honored only while the failing model still belongs to the
 * pinned chain (its primary, one of its entries, or a model its wildcard
 * covers). Otherwise the walk is exactly the failing model's own chain, so an
 * exhausted chain stops instead of borrowing another one.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	type RetryFallbackChains,
	type RetryFallbackResolutionContext,
	retryFallbackChainContainsSelector,
} from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";
import { TurnRecovery, type TurnRecoveryHost } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * The reported configuration shape: an exact-model chain (the advisor's own,
 * `maiarouter … -> entrim …`) plus an unrelated wildcard chain the advisor had
 * been pinned to earlier (`mammouth-vuln/* -> [oriona, …]`). The failing model
 * is NOT a member of the wildcard chain.
 */
const CHAINS: RetryFallbackChains = {
	"openai/gpt-4o-mini": ["openai/gpt-4o"],
	"anthropic/*": ["google/gemini-2.0-flash", "openai/gpt-4o"],
};

describe("stale retry-fallback pin", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let advisorModel: Model;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-stale-pin-");
		authStorage = await AuthStorage.create(tempDir.join("testauth.db"));
		authStorage.setRuntimeApiKey("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const bundled = getBundledModel("openai", "gpt-4o-mini");
		if (!bundled) throw new Error("Expected bundled model gpt-4o-mini");
		advisorModel = bundled;
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	function recovery(model: Model): TurnRecovery {
		const host = {
			settings: Settings.isolated({ "retry.fallbackChains": CHAINS }),
			modelRegistry,
			model: () => model,
			configWarnings: [],
			agent: { state: { messages: [] } },
			sessionId: () => "stale-pin-session",
		} as unknown as TurnRecoveryHost;
		return new TurnRecovery(host);
	}

	function context(): RetryFallbackResolutionContext {
		return {
			chains: CHAINS,
			getModelRole: () => undefined,
			modelLookup: modelRegistry,
		};
	}

	it("drops a pin the failing model no longer belongs to", () => {
		// The advisor sits on gpt-4o-mini — its own chain — while still pinned to
		// the wildcard chain from an earlier hop. Before the fix the walk was
		// ["anthropic/*", "openai/gpt-4o-mini"], so the wildcard chain's first
		// entry won and the advisor's own single entry was never reached.
		const keys = recovery(advisorModel).retryFallbackChainKeys("openai/gpt-4o-mini", advisorModel, {
			pinnedRole: "anthropic/*",
		});
		expect(keys).toEqual(["openai/gpt-4o-mini"]);
		expect(retryFallbackChainContainsSelector(context(), "anthropic/*", "openai/gpt-4o-mini")).toBe(false);
	});

	it("keeps a pin whose chain still contains the failing model", () => {
		// gemini is the wildcard chain's first configured entry: a live mid-chain
		// hop whose continuation the pin exists to serve (upstream #2555).
		const google = getBundledModel("google", "gemini-2.0-flash");
		if (!google) throw new Error("Expected bundled model gemini-2.0-flash");
		expect(retryFallbackChainContainsSelector(context(), "anthropic/*", "google/gemini-2.0-flash")).toBe(true);
		const keys = recovery(google).retryFallbackChainKeys("google/gemini-2.0-flash", google, {
			pinnedRole: "anthropic/*",
		});
		expect(keys).toEqual(["anthropic/*"]);
	});

	it("keeps a pin for a model the wildcard itself covers", () => {
		const anthropic = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!anthropic) throw new Error("Expected bundled model claude-sonnet-4-5");
		const keys = recovery(anthropic).retryFallbackChainKeys("anthropic/claude-sonnet-4-5", anthropic, {
			pinnedRole: "anthropic/*",
		});
		expect(keys).toEqual(["anthropic/*"]);
	});

	it("walks both keys when the pin is live and the model owns another chain", () => {
		// gpt-4o is both the wildcard chain's last entry (pin still live) and…
		const gpt4o = getBundledModel("openai", "gpt-4o");
		if (!gpt4o) throw new Error("Expected bundled model gpt-4o");
		expect(retryFallbackChainContainsSelector(context(), "anthropic/*", "openai/gpt-4o")).toBe(true);
		const keys = recovery(gpt4o).retryFallbackChainKeys("openai/gpt-4o", gpt4o, { pinnedRole: "anthropic/*" });
		expect(keys[0]).toBe("anthropic/*");
	});

	it("reports membership false for an unrelated exact chain", () => {
		expect(retryFallbackChainContainsSelector(context(), "openai/gpt-4o-mini", "google/gemini-2.0-flash")).toBe(
			false,
		);
	});
});
