import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelSelectorValue, parseModelString } from "@oh-my-pi/pi-tui/overlays/model-selector";
import { formatModelString, formatModelStringWithRouting } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import {
	type ConfiguredThinkingLevel,
	concreteThinkingLevel,
	resolveThinkingLevelForModel,
} from "@oh-my-pi/pi-tui/thinking";
import { resolveConfiguredModelPatterns, resolveModelRoleValue } from "../config/model-resolver";
import { getRoleInfo, isKindRole } from "../config/model-roles";

import { cfgRetryFallbackChains, cfgRetryFallbackRevertPolicy } from "./settings";

/** Configured fallback chains keyed by role or model selector. */
export type RetryFallbackChains = Record<string, string[]>;

/** Policy controlling restoration of a fallback chain's primary model. */
export type RetryFallbackRevertPolicy = "never" | "cooldown-expiry";

/** Parsed model selector used by retry fallback resolution. */
export interface RetryFallbackSelector {
	raw: string;
	provider: string;
	id: string;
	thinkingLevel: ThinkingLevel | undefined;
}

/** Minimal model lookup needed by fallback-chain resolution. */
export interface RetryFallbackModelLookup {
	find(provider: string, id: string): Model | undefined;
	hasProvider(provider: string): boolean;
}

/**
 * Inputs shared by startup (sdk) and runtime (turn-recovery) fallback-chain
 * resolution. Each configured chain retains its explicit role/model scope;
 * the default chain is not inherited by unrelated roles.
 */
export interface RetryFallbackResolutionContext {
	chains: RetryFallbackChains;
	getModelRole(role: string): string | undefined;
	modelLookup: RetryFallbackModelLookup;
}

/** Active retry fallback state retained until the primary can be restored. */
export interface ActiveRetryFallbackState {
	/** Chain key that produced this fallback: a model-role name or a model-selector key. */
	role: string;
	originalSelector: string;
	originalThinkingLevel: ConfiguredThinkingLevel | undefined;
	lastAppliedFallbackThinkingLevel: ConfiguredThinkingLevel | undefined;
	pinned: boolean;
	/** First fallback activation; later hops must not restart this clock. */
	startedAt: number;
	/** A successful fallback response has completed during this activation. */
	succeeded?: boolean;
	/** The most recent chain walk found no eligible remaining fallback. */
	chainExhausted?: boolean;
	/**
	 * Set once a turn on the fallback target settles successfully. Until then the
	 * switch is only a routing decision — nothing has been produced by the new
	 * model, so no observer may report the run as having used it.
	 */
	served?: boolean;
}

/** Model a session's produced work is attributed to. */
export interface ServingModel {
	/** Full selector including routing and thinking level. */
	selector: string;
	/** Provider/id including routing, with no added thinking suffix. */
	modelIdentity?: string;
	/** Concrete thinking level captured with the attributed model. */
	thinkingLevel?: ThinkingLevel;
	/** Whether fallback routing, rather than the configured primary, owns it. */
	isFallback: boolean;
	/**
	 * Context window of the attributed model, carried verbatim from
	 * {@link Model.contextWindow} (`null` when the model declares none), so
	 * observers size context usage against the model that produced the turn
	 * instead of the one the run started on.
	 */
	contextWindow?: number | null;
}

const RETRY_BACKOFF_MAX_DELAY_MS = 8_000;
const RETRY_BACKOFF_JITTER_RATIO = 0.25;

/** Calculates capped exponential retry delay with downward jitter. */
export function calculateRetryBackoffDelayMs(baseDelayMs: number, attempt: number): number {
	const cappedDelayMs = Math.min(Math.max(0, baseDelayMs) * 2 ** Math.max(0, attempt - 1), RETRY_BACKOFF_MAX_DELAY_MS);
	const jitter = 1 - Math.random() * RETRY_BACKOFF_JITTER_RATIO;
	return cappedDelayMs * jitter;
}

/** Fallback notices stay one line; the full text remains in the session log. */
const FALLBACK_REASON_MAX_CHARS = 160;

/**
 * One-line description of why a fallback fired, for the operator-facing notice.
 *
 * A bare `A -> B` line is unactionable: the whole question is which provider
 * failure caused the switch (auth, quota, rate limit, unsupported parameter).
 * The provider's own message answers it, so carry a trimmed copy on the event.
 */
export function describeFallbackReason(errorMessage: string | undefined): string | undefined {
	if (typeof errorMessage !== "string") return undefined;
	const flat = errorMessage.replace(/\s+/g, " ").trim();
	if (!flat) return undefined;
	return flat.length <= FALLBACK_REASON_MAX_CHARS ? flat : `${flat.slice(0, FALLBACK_REASON_MAX_CHARS - 1)}…`;
}

/** Parses a configured retry fallback selector. */
export function parseRetryFallbackSelector(
	selector: string,
	modelLookup?: Pick<RetryFallbackModelLookup, "find">,
): RetryFallbackSelector | undefined {
	const trimmed = selector.trim();
	if (!trimmed) return undefined;
	const parsed = parseModelString(trimmed, {
		allowMaxSuffix: true,
		allowAutoAlias: true,
		isLiteralModelId: (provider, id) => modelLookup?.find(provider, id) !== undefined,
	});
	if (!parsed) return undefined;
	return {
		raw: trimmed,
		provider: parsed.provider,
		id: parsed.id,
		thinkingLevel: concreteThinkingLevel(parsed.thinkingLevel),
	};
}

/** Whether a fallback-chain key is a model selector rather than a role. */
export function isRetryFallbackModelKey(key: string): boolean {
	return key.includes("/");
}

/** Whether a fallback-chain key or entry is a provider wildcard. */
export function isRetryFallbackWildcardKey(key: string): boolean {
	return key.endsWith("/*");
}

/** Splits a wildcard selector into provider and optional model-id prefix. */
export function parseRetryFallbackWildcard(
	key: string,
	isKnownProvider: (provider: string) => boolean,
): { provider: string; idPrefix: string | undefined } {
	const template = key.slice(0, -2);
	const slash = template.indexOf("/");
	if (slash < 0 || isKnownProvider(template)) return { provider: template, idPrefix: undefined };
	return { provider: template.slice(0, slash), idPrefix: template.slice(slash + 1) };
}

/** Formats a concrete model and thinking level as a fallback selector. */
export function formatRetryFallbackSelector(model: Model, thinkingLevel: ThinkingLevel | undefined): string {
	return formatModelSelectorValue(formatModelStringWithRouting(model), thinkingLevel);
}

/** Formats the model-only portion of a parsed fallback selector. */
function formatRetryFallbackBaseSelector(selector: RetryFallbackSelector): string {
	return `${selector.provider}/${selector.id}`;
}
/** Whether a concrete model can normalize this failing selector's routing and effort. */
function retryFallbackSelectorMatchesModel(selector: RetryFallbackSelector, model: Model): boolean {
	const sameModelId = (a: string, b: string): boolean =>
		a.toLowerCase().split("@")[0] === b.toLowerCase().split("@")[0];
	return sameModelId(selector.provider, model.provider) && sameModelId(selector.id, model.id);
}

/** Whether a provider is registered or configured for discovery. */
export function isKnownProvider(
	modelRegistry: Pick<RetryFallbackModelLookup, "hasProvider">,
	provider: string,
): boolean {
	return modelRegistry.hasProvider(provider);
}

/**
 * Resolve the configured chains for role lookup.
 *
 * Chains are STRICT: a role gets a chain only when one is configured for it by
 * name, and the `default` chain belongs to the `default` role alone. The
 * previous behaviour copied the `default` chain onto every role without its own
 * key, so any model that merely happened to be some role's primary inherited
 * it — an `antigravity-native/gemini-3.8-flash` timeout was answered with the
 * `default` chain's `azure1-bitfrost/openai/gpt-6-astra`, a provider the user
 * had configured no chain for. A model with no chain of its own must retry, not
 * borrow someone else's target.
 *
 * Roles that genuinely want a shared chain can name it explicitly per role.
 */
export function expandDefaultRetryFallbackChains(
	configuredChains: RetryFallbackChains,
	_roleNames: readonly string[],
): RetryFallbackChains {
	return { ...configuredChains };
}

/** Resolves configured fallback chains without inheriting the default chain. */
export function getRetryFallbackChains(settings: Settings): RetryFallbackChains {
	const configuredChains = cfgRetryFallbackChains.get(settings);
	if (!configuredChains || typeof configuredChains !== "object") return {};
	return expandDefaultRetryFallbackChains(configuredChains, Object.keys(settings.getModelRoles()));
}

/**
 * Catalog slice covering every provider a selector's patterns name, or
 * `undefined` when a pattern is provider-less and needs the whole catalog.
 */
function providerScopedPool(
	modelRegistry: Pick<ModelRegistry, "find" | "getProviderModels">,
	patterns: readonly string[],
): Model[] | undefined {
	const providers = new Set<string>();
	for (const pattern of patterns) {
		const parsed = parseRetryFallbackSelector(pattern, modelRegistry);
		if (!parsed) return undefined;
		providers.add(parsed.provider);
	}
	const pool: Model[] = [];
	for (const provider of providers) pool.push(...modelRegistry.getProviderModels(provider));
	return pool;
}

/**
 * Validates configured fallback chains and reports each warning via `warn`.
 *
 * `options.isDiscoveryPending` suppresses "unknown model" warnings for
 * selectors whose config-declared discovery provider has not yet populated the
 * registry (a cold discovery cache after `omp update` bumps the cache
 * namespace, #10048). Such selectors are re-checked once background discovery
 * settles. Logging is the caller's responsibility so a post-discovery re-run
 * does not double-log persistent warnings.
 */
export function validateRetryFallbackChains(
	settings: Settings,
	modelRegistry: Pick<ModelRegistry, "getAll" | "find" | "hasProvider" | "getProviderModels">,
	warn: (message: string) => void,
	options: { isDiscoveryPending?: (provider: string) => boolean } = {},
): void {
	const configuredChains = cfgRetryFallbackChains.get(settings);
	if (configuredChains === undefined) return;
	const report = warn;
	const isDiscoveryPending = options.isDiscoveryPending ?? (() => false);
	if (!configuredChains || typeof configuredChains !== "object" || Array.isArray(configuredChains)) {
		report("retry.fallbackChains must be a mapping of role names or model selectors to selector arrays.");
		return;
	}

	for (const key in configuredChains) {
		const chain = configuredChains[key];
		const keyKind = isRetryFallbackModelKey(key) ? "model" : "role";
		if (keyKind === "model") {
			if (isRetryFallbackWildcardKey(key)) {
				const { provider } = parseRetryFallbackWildcard(key, candidate =>
					isKnownProvider(modelRegistry, candidate),
				);
				if (!isKnownProvider(modelRegistry, provider)) {
					report(`retry.fallbackChains wildcard key references unknown provider: ${key}`);
				}
			} else {
				const parsedKey = parseRetryFallbackSelector(key, modelRegistry);
				if (!parsedKey) {
					report(`Invalid model selector key in retry.fallbackChains: ${key}`);
				} else if (
					!modelRegistry.find(parsedKey.provider, parsedKey.id) &&
					!isDiscoveryPending(parsedKey.provider)
				) {
					report(`retry.fallbackChains key references unknown model: ${key}`);
				}
			}
		}
		if (!Array.isArray(chain)) {
			report(`Fallback chain for ${keyKind} '${key}' must be an array of selector strings.`);
			continue;
		}
		// Compatibility is a catalog property, independent of credentials and enabled providers.
		const kindRole = keyKind === "role" && isKindRole(key) ? getRoleInfo(key, settings) : undefined;
		// Provider-qualified selectors are checked against their providers' slices
		// first; the full catalog (expensive to compose) only backs a failed check,
		// so warnings are unchanged while the happy path stays cheap.
		let kindRoleCatalog: Model[] | undefined;
		const resolvesForKindRole = (selectorStr: string, pool: Model[] | undefined): boolean =>
			pool !== undefined &&
			kindRole !== undefined &&
			resolveModelRoleValue(selectorStr, pool.filter(kindRole.accepts), { settings }).model !== undefined;
		for (const selectorStr of chain) {
			if (typeof selectorStr !== "string") {
				report(`Fallback chain for ${keyKind} '${key}' contains a non-string selector.`);
				continue;
			}
			if (kindRole) {
				const patterns = resolveConfiguredModelPatterns(selectorStr, settings);
				if (resolvesForKindRole(selectorStr, providerScopedPool(modelRegistry, patterns))) continue;
				kindRoleCatalog ??= modelRegistry.getAll("all");
				if (resolvesForKindRole(selectorStr, kindRoleCatalog)) continue;

				const pending =
					patterns.length > 0 &&
					patterns.every(pattern => {
						const parsed = parseRetryFallbackSelector(pattern, modelRegistry);
						return parsed ? isDiscoveryPending(parsed.provider) : false;
					});
				if (!pending) {
					report(`Fallback chain for role '${key}' does not resolve to a compatible model: ${selectorStr}`);
				}
				continue;
			}
			if (isRetryFallbackWildcardKey(selectorStr)) {
				const { provider } = parseRetryFallbackWildcard(selectorStr, candidate =>
					isKnownProvider(modelRegistry, candidate),
				);
				if (!isKnownProvider(modelRegistry, provider)) {
					report(`Fallback chain for ${keyKind} '${key}' references unknown provider: ${selectorStr}`);
				}
				continue;
			}
			const parsed = parseRetryFallbackSelector(selectorStr, modelRegistry);
			if (!parsed) {
				report(`Invalid fallback selector format in ${keyKind} '${key}': ${selectorStr}`);
				continue;
			}
			if (!modelRegistry.find(parsed.provider, parsed.id) && !isDiscoveryPending(parsed.provider)) {
				report(`Fallback chain for ${keyKind} '${key}' references unknown model: ${selectorStr}`);
			}
		}
	}
}

/** Returns the configured fallback-primary restoration policy. */
export function getRetryFallbackRevertPolicy(settings: Settings): RetryFallbackRevertPolicy {
	return cfgRetryFallbackRevertPolicy.get(settings) === "never" ? "never" : "cooldown-expiry";
}

/** Resolves the primary selector represented by a fallback-chain key. */
function getRetryFallbackPrimarySelector(
	context: RetryFallbackResolutionContext,
	chainKey: string,
): RetryFallbackSelector | undefined {
	if (isRetryFallbackWildcardKey(chainKey)) return undefined;
	if (isRetryFallbackModelKey(chainKey)) return parseRetryFallbackSelector(chainKey, context.modelLookup);
	const configuredSelector = context.getModelRole(chainKey);
	return configuredSelector ? parseRetryFallbackSelector(configuredSelector, context.modelLookup) : undefined;
}

/** How a chain key's primary selector matches the current selector. */
type SelectorMatchKind = "exact" | "normalized" | "base" | "none";

/**
 * Classify how a chain key's primary selector matches the current selector.
 * Comparisons use parsed model + thinking-level values, so effort aliases
 * (`hi`/`med`/`min`) match their canonical forms (`high`/`medium`/`minimal`).
 *
 * - `exact` — same provider/model and parsed effort.
 * - `normalized` — same provider/model and both efforts clamp to the same
 *   level supported by the active model (`max` and `high` on a high-capped
 *   model).
 * - `base` — a suffixless key naming the same provider/model, so it applies
 *   to that model at any effort.
 * - `none` — no match. Explicit efforts that remain distinct after model
 *   normalization must never masquerade as exact matches.
 */
function selectorMatchKind(
	primary: RetryFallbackSelector | undefined,
	current: RetryFallbackSelector,
	currentPlain: RetryFallbackSelector | undefined,
	currentModel: Model | null | undefined,
): SelectorMatchKind {
	if (!primary) return "none";
	const provider = primary.provider;
	const id = primary.id;
	const level = primary.thinkingLevel;
	let matchedCurrent: RetryFallbackSelector | undefined;
	if (provider === current.provider && id === current.id) {
		matchedCurrent = current;
	} else if (currentPlain !== undefined && provider === currentPlain.provider && id === currentPlain.id) {
		matchedCurrent = currentPlain;
	}
	if (!matchedCurrent) return "none";
	if (level === matchedCurrent.thinkingLevel) return "exact";
	if (level === undefined) return "base";
	if (
		currentModel &&
		resolveThinkingLevelForModel(currentModel, level) ===
			resolveThinkingLevelForModel(currentModel, matchedCurrent.thinkingLevel)
	) {
		return "normalized";
	}
	return "none";
}

/**
 * Resolve the chain key for a concrete selector by specificity: exact model,
 * longest matching wildcard, hinted role, then matching role keys with
 * `default` preferred over other shared assignments, then default.
 */
export function resolveRetryFallbackChainKey(
	context: RetryFallbackResolutionContext,
	currentSelector: string,
	currentModel?: Model | null,
	roleHint?: string,
): string | undefined {
	const parsedConfigured = parseRetryFallbackSelector(currentSelector, context.modelLookup);
	// `currentModel` exists only to NORMALIZE the failing selector (a raw or
	// unparseable selector still has to find its own chain). It must never widen
	// the match: the session model can differ from the model that actually
	// failed — a subagent/advisor turn, a role-scoped call, a model switched
	// after the request went out — and matching a chain key against it made an
	// unrelated failing model inherit the session model's chain
	// (`antigravity-native/gemini-3.8-flash` picking up the `default` chain's
	// `azure1-bitfrost/openai/gpt-6-astra`). Chains are strict: per model or per
	// provider, matched against the FAILING selector only.
	// Routing-suffixed selectors (`openrouter/z-ai/glm-4.7@cerebras`) name the
	// same model as the bare id the registry holds, so identity is compared
	// with the `@route` suffix stripped from both sides.
	const currentModelIsFailingModel =
		currentModel !== undefined &&
		currentModel !== null &&
		(parsedConfigured === undefined || retryFallbackSelectorMatchesModel(parsedConfigured, currentModel));
	const currentPlainSelector =
		currentModel && currentModelIsFailingModel
			? formatModelSelectorValue(formatModelString(currentModel), parsedConfigured?.thinkingLevel)
			: undefined;
	const parsedCurrent =
		parsedConfigured ??
		(currentPlainSelector ? parseRetryFallbackSelector(currentPlainSelector, context.modelLookup) : undefined);
	if (!parsedCurrent) {
		if (roleHint && Array.isArray(context.chains[roleHint])) return roleHint;
		return undefined;
	}
	const parsedPlainCurrent =
		currentPlainSelector && currentPlainSelector !== currentSelector
			? (parseRetryFallbackSelector(currentPlainSelector, context.modelLookup) ?? parsedCurrent)
			: undefined;

	// 1. Model-selector keys — most specific. Parsed exact effort beats
	//    model-normalized effort, which beats a suffixless (any-effort) key,
	//    regardless of object/YAML order. Efforts that remain distinct after
	//    normalization never match.
	let normalizedModelKey: string | undefined;
	let baseModelKey: string | undefined;
	for (const key in context.chains) {
		if (!isRetryFallbackModelKey(key) || isRetryFallbackWildcardKey(key)) continue;
		const kind = selectorMatchKind(
			getRetryFallbackPrimarySelector(context, key),
			parsedCurrent,
			parsedPlainCurrent,
			currentModelIsFailingModel ? currentModel : undefined,
		);
		if (kind === "exact") return key;
		if (kind === "normalized") normalizedModelKey ??= key;
		if (kind === "base") baseModelKey ??= key;
	}
	if (normalizedModelKey) return normalizedModelKey;
	if (baseModelKey) return baseModelKey;

	// 2. Provider wildcards — an id-prefixed key (`openrouter/google/*`)
	//    beats the plain `provider/*` key for ids under its prefix.
	let wildcardMatch: string | undefined;
	let wildcardPrefixLength = -1;
	for (const key in context.chains) {
		if (!isRetryFallbackWildcardKey(key) || !Array.isArray(context.chains[key])) continue;
		const { provider, idPrefix } = parseRetryFallbackWildcard(key, provider =>
			context.modelLookup.hasProvider(provider),
		);
		if (provider !== parsedCurrent.provider) continue;
		if (idPrefix !== undefined && !parsedCurrent.id.startsWith(`${idPrefix}/`)) continue;
		const prefixLength = idPrefix?.length ?? 0;
		if (prefixLength > wildcardPrefixLength) {
			wildcardMatch = key;
			wildcardPrefixLength = prefixLength;
		}
	}
	if (wildcardMatch) return wildcardMatch;

	// 3. The hinted role, then role keys matched by their assigned model.
	// A shared assignment (default and vision both the same model) must not
	// let yaml insertion order steal the live role's chain. Prefer the hint,
	// then `default` when it also matches.
	//
	// The hint only breaks TIES between roles that already match — it never
	// grants a chain to a model the role does not point at. A hint is derived
	// from the last model-change role, which can name a role whose assignment
	// has since moved (or never matched the failing model at all); honoring it
	// blindly routed an unrelated failing model into that role's chain.
	if (
		roleHint &&
		Array.isArray(context.chains[roleHint]) &&
		selectorMatchKind(
			getRetryFallbackPrimarySelector(context, roleHint),
			parsedCurrent,
			parsedPlainCurrent,
			currentModelIsFailingModel ? currentModel : undefined,
		) !== "none"
	) {
		return roleHint;
	}
	let matchedRole: string | undefined;
	for (const key in context.chains) {
		if (isRetryFallbackModelKey(key)) continue;
		if (
			selectorMatchKind(
				getRetryFallbackPrimarySelector(context, key),
				parsedCurrent,
				parsedPlainCurrent,
				currentModelIsFailingModel ? currentModel : undefined,
			) !== "none"
		) {
			if (key === "default") return "default";
			matchedRole ??= key;
		}
	}
	if (matchedRole) return matchedRole;

	// An unassigned default chain can cover a live model; an explicit primary
	// owns its chain and must never lend it to an unrelated model.
	const defaultChain = context.chains.default;
	if (
		Array.isArray(defaultChain) &&
		defaultChain.length > 0 &&
		currentModelIsFailingModel &&
		!context.getModelRole("default")
	) {
		return "default";
	}
	return undefined;
}

/**
 * Parse one configured chain entry. A `provider/*` entry keeps the failing
 * model's id and swaps the provider (google-antigravity/x → google/x); an
 * id-prefixed `provider/prefix/*` entry re-prefixes the failing model's
 * bare id instead (openrouter/google/* : google-antigravity/x →
 * openrouter/google/x). Ids the target provider lacks are skipped by the
 * candidate loop's registry lookup.
 */
function parseRetryFallbackChainEntry(
	context: RetryFallbackResolutionContext,
	entry: string,
	current: RetryFallbackSelector | undefined,
): RetryFallbackSelector | undefined {
	if (!isRetryFallbackWildcardKey(entry)) return parseRetryFallbackSelector(entry, context.modelLookup);
	if (!current) return undefined;
	const { provider, idPrefix } = parseRetryFallbackWildcard(entry, candidate =>
		context.modelLookup.hasProvider(candidate),
	);
	const bareId = current.id.slice(current.id.lastIndexOf("/") + 1);
	let id: string;
	if (idPrefix !== undefined) {
		id = `${idPrefix}/${bareId}`;
	} else if (
		bareId !== current.id &&
		!context.modelLookup.find(provider, current.id) &&
		context.modelLookup.find(provider, bareId)
	) {
		// Aggregator → direct: the failing id carries a vendor prefix the
		// target provider does not use (openrouter/google/x → google-vertex/x).
		id = bareId;
	} else {
		id = current.id;
	}
	return { raw: `${provider}/${id}`, provider, id, thinkingLevel: undefined };
}

/** Builds a fallback chain beginning with its effective primary selector. */
function getRetryFallbackEffectiveChain(
	context: RetryFallbackResolutionContext,
	chainKey: string,
	currentSelector: string,
	currentModel: Model | null | undefined,
	allowMissingPrimary: boolean,
): RetryFallbackSelector[] {
	const parsedConfigured = parseRetryFallbackSelector(currentSelector, context.modelLookup);
	const parsedCurrent =
		parsedConfigured ??
		(currentModel
			? parseRetryFallbackSelector(
					formatModelSelectorValue(formatModelString(currentModel), undefined),
					context.modelLookup,
				)
			: undefined);
	const seen = new Set<string>();
	const chain: RetryFallbackSelector[] = [];
	if (isRetryFallbackWildcardKey(chainKey)) {
		// A wildcard key has no fixed primary: the active model is the
		// primary, followed by the configured provider-level fallbacks.
		if (parsedCurrent) {
			chain.push(parsedCurrent);
			seen.add(parsedCurrent.raw);
		}
	} else {
		const primarySelector = getRetryFallbackPrimarySelector(context, chainKey);
		if (primarySelector) {
			chain.push(primarySelector);
			seen.add(primarySelector.raw);
		} else if ((chainKey === "default" || allowMissingPrimary) && parsedCurrent) {
			chain.push(parsedCurrent);
			seen.add(parsedCurrent.raw);
		} else if (!allowMissingPrimary) {
			return [];
		}
	}
	for (const selector of context.chains[chainKey] ?? []) {
		const parsed = parseRetryFallbackChainEntry(context, selector, parsedCurrent);
		if (!parsed || seen.has(parsed.raw)) continue;
		seen.add(parsed.raw);
		chain.push(parsed);
	}
	return chain;
}

/**
 * Whether `currentSelector` actually belongs to `chainKey` — its primary, one
 * of its configured entries, or (for a wildcard key) a model the wildcard
 * covers.
 *
 * Used to discard a STALE pin. `#activeRetryFallback.role` is pinned at the
 * first hop and never re-resolved, so an advisor (or session) whose model later
 * changes by another route — `/advisor configure`, profile sync, context
 * promotion — keeps a pin for a chain it no longer sits in. The pinned chain is
 * consulted BEFORE the failing model's own chain, so a stale pin silently
 * overrode a configured `model -> [fallback]` mapping (the advisor's
 * `maiarouter … -> entrim …` chain lost to a leftover `mammouth-vuln/*` pin and
 * fell back to that chain's kimi models instead).
 *
 * Deliberately does NOT use {@link getRetryFallbackEffectiveChain}: a wildcard
 * key synthesizes the active model as its own primary, so every model would
 * look like a member.
 */
export function retryFallbackChainContainsSelector(
	context: RetryFallbackResolutionContext,
	chainKey: string,
	currentSelector: string,
	currentModel?: Model | null,
): boolean {
	const chain = context.chains[chainKey];
	if (!Array.isArray(chain)) return false;
	const parsedConfigured = parseRetryFallbackSelector(currentSelector, context.modelLookup);
	const matchingModel =
		currentModel && (!parsedConfigured || retryFallbackSelectorMatchesModel(parsedConfigured, currentModel))
			? currentModel
			: undefined;
	const currentPlainSelector = matchingModel
		? formatModelSelectorValue(formatModelString(matchingModel), parsedConfigured?.thinkingLevel)
		: undefined;
	const parsedCurrent =
		parsedConfigured ??
		(currentPlainSelector ? parseRetryFallbackSelector(currentPlainSelector, context.modelLookup) : undefined);
	if (!parsedCurrent) return false;
	const parsedPlainCurrent =
		currentPlainSelector && currentPlainSelector !== currentSelector
			? (parseRetryFallbackSelector(currentPlainSelector, context.modelLookup) ?? parsedCurrent)
			: undefined;
	const currentBaseSelector = formatRetryFallbackBaseSelector(parsedCurrent);
	const currentPlainBaseSelector =
		currentPlainSelector && currentPlainSelector !== currentSelector
			? formatRetryFallbackBaseSelector(parseRetryFallbackSelector(currentPlainSelector) ?? parsedCurrent)
			: undefined;

	// A wildcard key owns every model of its provider (under its id prefix).
	if (isRetryFallbackWildcardKey(chainKey)) {
		const { provider, idPrefix } = parseRetryFallbackWildcard(chainKey, candidate =>
			context.modelLookup.hasProvider(candidate),
		);
		if (
			provider === parsedCurrent.provider &&
			(idPrefix === undefined || parsedCurrent.id.startsWith(`${idPrefix}/`))
		) {
			return true;
		}
	} else if (
		selectorMatchKind(
			getRetryFallbackPrimarySelector(context, chainKey),
			parsedCurrent,
			parsedPlainCurrent,
			matchingModel,
		) !== "none"
	) {
		return true;
	}

	// Or the model landed on one of the configured entries — the mid-chain hop
	// whose continuation the pin exists to serve.
	for (const entry of chain) {
		const parsed = parseRetryFallbackChainEntry(context, entry, parsedCurrent);
		if (!parsed) continue;
		if (parsed.raw === currentSelector || parsed.raw === currentPlainSelector) return true;
		const base = formatRetryFallbackBaseSelector(parsed);
		if (base === currentBaseSelector || (!!currentPlainBaseSelector && base === currentPlainBaseSelector))
			return true;
	}
	return false;
}

/**
 * Return candidates after the current selector in an effective chain.
 * `wrapAround` additionally appends entries before the current selector,
 * without returning the current selector itself.
 */
export function findRetryFallbackCandidates(
	context: RetryFallbackResolutionContext,
	chainKey: string,
	currentSelector: string,
	currentModel?: Model | null,
	options?: { allowMissingPrimary?: boolean; wrapAround?: boolean },
): RetryFallbackSelector[] {
	const chain = getRetryFallbackEffectiveChain(
		context,
		chainKey,
		currentSelector,
		currentModel,
		options?.allowMissingPrimary === true,
	);
	const parsedConfigured = parseRetryFallbackSelector(currentSelector, context.modelLookup);
	const currentPlainSelector = currentModel
		? formatModelSelectorValue(formatModelString(currentModel), parsedConfigured?.thinkingLevel)
		: undefined;
	const parsedCurrent =
		parsedConfigured ??
		(currentPlainSelector ? parseRetryFallbackSelector(currentPlainSelector, context.modelLookup) : undefined);
	if (!parsedCurrent) return chain;
	if (chain.length <= 1) return [];
	const currentBaseSelector = formatRetryFallbackBaseSelector(parsedCurrent);
	const currentPlainBaseSelector =
		parsedCurrent && currentPlainSelector && currentPlainSelector !== currentSelector
			? formatRetryFallbackBaseSelector(parseRetryFallbackSelector(currentPlainSelector) ?? parsedCurrent)
			: undefined;
	const exactIndex = chain.findIndex(
		selector => selector.raw === currentSelector || selector.raw === currentPlainSelector,
	);
	if (exactIndex >= 0) {
		const candidatesAfter = chain.slice(exactIndex + 1);
		return options?.wrapAround ? [...candidatesAfter, ...chain.slice(0, exactIndex)] : candidatesAfter;
	}
	const baseIndex = currentBaseSelector
		? chain.findIndex(selector => {
				const selectorBase = formatRetryFallbackBaseSelector(selector);
				return selectorBase === currentBaseSelector || selectorBase === currentPlainBaseSelector;
			})
		: -1;
	if (baseIndex >= 0) {
		const candidatesAfter = chain.slice(baseIndex + 1);
		return options?.wrapAround ? [...candidatesAfter, ...chain.slice(0, baseIndex)] : candidatesAfter;
	}
	return chain;
}
