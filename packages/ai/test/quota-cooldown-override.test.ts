/**
 * `retry.quotaCooldownMs` — the quota-class cooldown is configurable.
 *
 * A model suppressed for account-local quota exhaustion was pinned to a
 * hardcoded 30 minutes, so a session could not return to its primary model any
 * sooner even when the operator knew the window was shorter. The override is
 * deliberately narrow: only the quota class (and the conservative default for
 * unclassified-but-recognized reasons) moves, and a provider-supplied
 * `retry-after` still wins because the caller applies that hint first.
 */
import { describe, expect, it } from "bun:test";
import { calculateRateLimitBackoffMs, DEFAULT_QUOTA_EXHAUSTED_BACKOFF_MS } from "@oh-my-pi/pi-ai/error/rate-limit";

const TWELVE_MINUTES_MS = 12 * 60 * 1000;

describe("calculateRateLimitBackoffMs quota override", () => {
	it("keeps the 30-minute default when no override is supplied", () => {
		expect(DEFAULT_QUOTA_EXHAUSTED_BACKOFF_MS).toBe(30 * 60 * 1000);
		expect(calculateRateLimitBackoffMs("QUOTA_EXHAUSTED")).toBe(30 * 60 * 1000);
		expect(calculateRateLimitBackoffMs("INSUFFICIENT_G1_CREDITS_BALANCE")).toBe(30 * 60 * 1000);
	});

	it("applies the override to both quota reasons and the conservative default", () => {
		expect(calculateRateLimitBackoffMs("QUOTA_EXHAUSTED", TWELVE_MINUTES_MS)).toBe(TWELVE_MINUTES_MS);
		expect(calculateRateLimitBackoffMs("INSUFFICIENT_G1_CREDITS_BALANCE", TWELVE_MINUTES_MS)).toBe(TWELVE_MINUTES_MS);
		// "UNKNOWN" is handled by the caller (5 min); every other classified
		// reason falls through to the conservative quota value.
		expect(calculateRateLimitBackoffMs("UNKNOWN", TWELVE_MINUTES_MS)).toBe(TWELVE_MINUTES_MS);
	});

	it("leaves the transient classes untouched", () => {
		expect(calculateRateLimitBackoffMs("RATE_LIMIT_EXCEEDED", TWELVE_MINUTES_MS)).toBe(30 * 1000);
		expect(calculateRateLimitBackoffMs("CONCURRENT_LIMIT", TWELVE_MINUTES_MS)).toBe(5 * 1000);
		expect(calculateRateLimitBackoffMs("SERVER_ERROR", TWELVE_MINUTES_MS)).toBe(20 * 1000);
		const capacity = calculateRateLimitBackoffMs("MODEL_CAPACITY_EXHAUSTED", TWELVE_MINUTES_MS);
		expect(capacity).toBeGreaterThanOrEqual(45 * 1000);
		expect(capacity).toBeLessThanOrEqual(75 * 1000);
	});

	it("ignores unusable override values and falls back to the default", () => {
		for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(calculateRateLimitBackoffMs("QUOTA_EXHAUSTED", bad)).toBe(30 * 60 * 1000);
		}
	});
});
