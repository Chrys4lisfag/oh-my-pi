/**
 * Fallback chains are STRICT: a chain applies only to the model that failed.
 *
 * `retry.fallbackChains` keys are per model (`provider/id`), per provider
 * (`provider/*`), or a role. Nothing else may capture a failing model. Two
 * leaks violated that:
 *
 * 1. `currentModel` (the SESSION model) was folded into the match via
 *    `currentPlainSelector`, so when the failing model differed from the
 *    session model — a subagent/advisor turn, a role-scoped call, a model
 *    switched after the request went out — the failing model inherited the
 *    session model's chain.
 * 2. `roleHint` returned that role's chain without checking the role points at
 *    the failing model. The hint comes from the last model-change role, which
 *    may have moved since.
 *
 * Reported shape: `antigravity-native/gemini-3.8-flash:high` timed out and fell
 * back to `azure1-bitfrost/openai/gpt-6-astra` — the `default` chain's entry —
 * with no chain configured for `antigravity-native` or for that model.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	findRetryFallbackCandidates,
	type RetryFallbackChains,
	type RetryFallbackResolutionContext,
	resolveRetryFallbackChainKey,
} from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";
import { TempDir } from "@oh-my-pi/pi-utils";

/** Mirrors the reported config: a `default` chain plus unrelated per-provider chains. */
const CHAINS: RetryFallbackChains = {
	default: ["openai/gpt-4o"],
	"anthropic/*": ["openai/gpt-4o-mini"],
	"openai/gpt-4o-mini": ["openai/gpt-4o"],
};

/** The session/default-role model — NOT the model that fails below. */
const DEFAULT_ROLE_SELECTOR = "openai/gpt-4o-mini";

describe("retry fallback chains are strictly scoped", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;
	let sessionModel: Model;
	/** A model with no chain of its own and no wildcard covering it. */
	let unrelatedSelector: string;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-strict-chains-");
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		for (const provider of ["openai", "anthropic", "google"]) {
			authStorage.keys.setRuntime(provider, "test-key");
		}
		registry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const session = getBundledModel("openai", "gpt-4o-mini");
		const unrelated = getBundledModel("google", "gemini-2.0-flash");
		if (!session || !unrelated) throw new Error("expected bundled models");
		sessionModel = session;
		unrelatedSelector = `${unrelated.provider}/${unrelated.id}:high`;
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	function context(): RetryFallbackResolutionContext {
		return {
			chains: CHAINS,
			getModelRole: role => (role === "default" ? DEFAULT_ROLE_SELECTOR : undefined),
			modelLookup: registry,
		};
	}

	it("does not hand the session model's chain to an unrelated failing model", () => {
		// The exact reported bug: session sits on the default-role model while a
		// different model fails.
		const key = resolveRetryFallbackChainKey(context(), unrelatedSelector, sessionModel, undefined);
		expect(key).toBeUndefined();
		// No key means no walk, so nothing can be offered. (Calling
		// `findRetryFallbackCandidates` with a chain key directly stays
		// permissive by design — compaction uses `allowMissingPrimary` to list a
		// chain's entries for a model that is not in it.)
		expect(key ? findRetryFallbackCandidates(context(), key, unrelatedSelector, sessionModel) : []).toEqual([]);
	});

	it("does not honour a role hint that does not point at the failing model", () => {
		const key = resolveRetryFallbackChainKey(context(), unrelatedSelector, undefined, "default");
		expect(key).toBeUndefined();
	});

	it("does not honour a role hint even when the session model matches that role", () => {
		// Both leaks at once: hint says `default`, session model IS the default
		// role's model, but the FAILING model is unrelated.
		const key = resolveRetryFallbackChainKey(context(), unrelatedSelector, sessionModel, "default");
		expect(key).toBeUndefined();
	});

	it("still resolves the failing model's own exact chain", () => {
		const key = resolveRetryFallbackChainKey(context(), DEFAULT_ROLE_SELECTOR, sessionModel, undefined);
		expect(key).toBe(DEFAULT_ROLE_SELECTOR);
	});

	it("still resolves a provider wildcard for a model it covers", () => {
		const anthropic = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!anthropic) throw new Error("expected bundled model");
		const key = resolveRetryFallbackChainKey(
			context(),
			`${anthropic.provider}/${anthropic.id}`,
			anthropic,
			undefined,
		);
		expect(key).toBe("anthropic/*");
	});

	it("still honours a role hint when the role does point at the failing model", () => {
		// The hint's legitimate job: break ties between roles sharing an
		// assignment. It applies because the failing model IS the role's model.
		const key = resolveRetryFallbackChainKey(context(), DEFAULT_ROLE_SELECTOR, sessionModel, "default");
		expect(key === "default" || key === DEFAULT_ROLE_SELECTOR).toBe(true);
	});

	it("normalizes an unparseable selector using the session model only when they are the same model", () => {
		// `currentModel` may still normalize the failing selector — that is its
		// only remaining job.
		const key = resolveRetryFallbackChainKey(context(), "gpt-4o-mini", sessionModel, undefined);
		expect(key).toBe(DEFAULT_ROLE_SELECTOR);
	});

	it("does not let a role inherit the default chain", () => {
		// The reported path: the failing model is some role's assigned primary,
		// that role has NO chain of its own, and the `default` chain was copied
		// onto it — so an unconfigured provider was answered with the default
		// chain's target.
		const roleHostsUnrelatedModel: RetryFallbackResolutionContext = {
			chains: CHAINS,
			getModelRole: role =>
				role === "vision" ? unrelatedSelector : role === "default" ? DEFAULT_ROLE_SELECTOR : undefined,
			modelLookup: registry,
		};
		// `vision` has no configured chain, so there is nothing to inherit.
		expect(roleHostsUnrelatedModel.chains.vision).toBeUndefined();
		const key = resolveRetryFallbackChainKey(roleHostsUnrelatedModel, unrelatedSelector, undefined, "vision");
		expect(key).toBeUndefined();
	});

	it("still resolves a role chain configured explicitly for that role", () => {
		// The strictness boundary: same role, same primary — the only difference
		// is that the chain is configured by name. Inheritance is gone; explicit
		// per-role configuration keeps working.
		const explicitRoleChain: RetryFallbackResolutionContext = {
			chains: { ...CHAINS, vision: ["openai/gpt-4o"] },
			getModelRole: role =>
				role === "vision" ? unrelatedSelector : role === "default" ? DEFAULT_ROLE_SELECTOR : undefined,
			modelLookup: registry,
		};
		expect(resolveRetryFallbackChainKey(explicitRoleChain, unrelatedSelector, undefined, "vision")).toBe("vision");
		expect(
			findRetryFallbackCandidates(explicitRoleChain, "vision", unrelatedSelector).map(candidate => candidate.raw),
		).toEqual(["openai/gpt-4o"]);
	});

	it("leaves an unconfigured model with zero candidates so it retries in place", () => {
		// The user-visible contract: a timeout on a model with no chain must be
		// retried on the same model, never answered with someone else's target.
		for (const hint of [undefined, "default", "vision", "task"]) {
			for (const model of [undefined, sessionModel]) {
				const key = resolveRetryFallbackChainKey(context(), unrelatedSelector, model, hint);
				expect(key).toBeUndefined();
			}
		}
	});
});
