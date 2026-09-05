/**
 * `retry.quotaCooldownMs` end to end: the configured value is what suppresses
 * the failing selector.
 *
 * `noteRetryFallbackCooldown` used a hardcoded 30-minute quota backoff, so a
 * session that fell back on quota exhaustion could not return to its primary
 * model sooner even when the operator knew the window was shorter. The knob
 * only governs the class-based fallback — a provider-supplied `retry-after` is
 * applied before the class lookup and stays authoritative.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TurnRecovery, type TurnRecoveryHost } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { TempDir } from "@oh-my-pi/pi-utils";

const TWELVE_MINUTES_MS = 12 * 60 * 1000;
const QUOTA_ERROR = "429 insufficient credits for this account";

describe("retry.quotaCooldownMs", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let model: Model;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-quota-cooldown-");
		authStorage = await AuthStorage.create(tempDir.join("testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled model claude-sonnet-4-5");
		model = bundled;
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	/** Deadline the recovery path handed to the registry, as a duration. */
	function cooldownFor(
		settingsValues: Record<string, unknown>,
		retryAfterMs: number | undefined,
		errorMessage: string,
	): number {
		let deadline = 0;
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		modelRegistry.suppressSelector = (_selector: string, until: number) => {
			deadline = until;
		};
		const host = {
			settings: Settings.isolated(settingsValues),
			modelRegistry,
			model: () => model,
			configWarnings: [],
			agent: { state: { messages: [] } },
			sessionId: () => "quota-cooldown-session",
		} as unknown as TurnRecoveryHost;
		const before = Date.now();
		new TurnRecovery(host).noteRetryFallbackCooldown(`${model.provider}/${model.id}`, retryAfterMs, errorMessage);
		return deadline - before;
	}

	it("defaults to 30 minutes when unset", () => {
		const cooldown = cooldownFor({}, undefined, QUOTA_ERROR);
		expect(cooldown).toBeGreaterThan(29 * 60 * 1000);
		expect(cooldown).toBeLessThanOrEqual(30 * 60 * 1000 + 1_000);
	});

	it("suppresses for the configured window instead", () => {
		const cooldown = cooldownFor({ "retry.quotaCooldownMs": TWELVE_MINUTES_MS }, undefined, QUOTA_ERROR);
		expect(cooldown).toBeGreaterThan(11 * 60 * 1000);
		expect(cooldown).toBeLessThanOrEqual(TWELVE_MINUTES_MS + 1_000);
	});

	it("still honours a provider retry-after over the configured window", () => {
		const providerHintMs = 90 * 60 * 1000;
		const cooldown = cooldownFor({ "retry.quotaCooldownMs": TWELVE_MINUTES_MS }, providerHintMs, QUOTA_ERROR);
		expect(cooldown).toBeGreaterThan(89 * 60 * 1000);
		expect(cooldown).toBeLessThanOrEqual(providerHintMs + 1_000);
	});

	it("leaves transient rate-limit cooldowns alone", () => {
		const cooldown = cooldownFor(
			{ "retry.quotaCooldownMs": TWELVE_MINUTES_MS },
			undefined,
			"429 too many requests per minute",
		);
		expect(cooldown).toBeLessThanOrEqual(60 * 1000);
	});
});
