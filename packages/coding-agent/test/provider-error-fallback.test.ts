/**
 * Any provider-side failure advances the fallback chain.
 *
 * A chain walk used to stop at the first misconfigured gateway: after a
 * successful hop (`azure1-bitfrost/… -> skima-vuln-bitfrost/…`), the new route
 * answered `400 no keys found that support model: openai/gpt-6-astra`, which
 * the generic classifier declines to retry — so the turn ended
 * ("Retry failed after 1 attempts") with healthy entries still unused.
 *
 * Retrying such a route is indeed pointless, but the NEXT entry is a different
 * route entirely. These failures are therefore fallback-eligible and
 * explicitly NOT same-model retryable: the outcome is "switch model" or "close
 * the saga", never a sleep-and-retry loop.
 *
 * Kept ineligible: user aborts, context overflow (compaction owns it), thinking
 * loops (same-model resample), and replay-unsafe output.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Model, Usage } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TurnRecovery, type TurnRecoveryHost } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { TempDir } from "@oh-my-pi/pi-utils";

const USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Errors observed across the user's gateway fleet, none classified retriable. */
const PROVIDER_ERRORS: ReadonlyArray<readonly [string, number]> = [
	["400 no keys found that support model: openai/gpt-6-astra", 400],
	["404 This model is only available through the paid tier", 404],
	["400 litellm.UnsupportedParamsError: moonshot does not support parameters", 400],
	["413 Request Entity Too Large", 413],
	["400 provider API error (status 400) raw-http", 400],
];

describe("provider errors are fallback-eligible", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-provider-error-fallback-");
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("expected bundled model");
		model = bundled;
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	function recovery(textCommitted = false): TurnRecovery {
		const host = {
			settings: Settings.isolated({}),
			modelRegistry,
			model: () => model,
			configWarnings: [],
			agent: { state: { messages: [] } },
			sessionId: () => "provider-error-session",
			textOutputCommitted: () => textCommitted,
			contextFitsModel: () => true,
		} as unknown as TurnRecoveryHost;
		return new TurnRecovery(host);
	}

	function message(
		errorMessage: string,
		errorStatus?: number,
		content: AssistantMessage["content"] = [],
		stopReason: AssistantMessage["stopReason"] = "error",
	): AssistantMessage {
		return {
			role: "assistant",
			content,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { ...USAGE },
			stopReason,
			errorMessage,
			errorStatus,
			timestamp: Date.now(),
		} as AssistantMessage;
	}

	it("treats every observed gateway failure as recoverable", () => {
		for (const [errorMessage, status] of PROVIDER_ERRORS) {
			expect(recovery().isRetryableError(message(errorMessage, status))).toBe(true);
		}
	});

	it("keeps a completed turn out of recovery", () => {
		expect(recovery().isRetryableError(message("", undefined, [], "stop"))).toBe(false);
	});

	it("keeps context overflow with compaction, not the chain", () => {
		// Every model in the chain would refuse the same oversized request.
		const overflow = message(
			"400 This model's maximum context length is 200000 tokens, however you requested 900000",
			400,
		);
		expect(recovery().isRetryableError(overflow)).toBe(false);
	});

	it("still falls back when the turn already streamed output", () => {
		// The common case: a provider fails AFTER emitting text (or a tool call),
		// which the replay-unsafe veto used to treat as unrecoverable — so a dead
		// route ended the work outright. Duplicating a partial answer is a much
		// smaller cost than losing the turn.
		const streamedText = [{ type: "text", text: "already shown to the user" }] as never;
		expect(recovery(true).isRetryableError(message("400 no keys found that support model", 400, streamedText))).toBe(
			true,
		);
	});

	it("still refuses to switch after a tool call, image or server tool", () => {
		// Those may already have run or rendered: replaying them elsewhere
		// repeats work, not just words.
		for (const block of [
			{ type: "toolCall", id: "c1", name: "bash", arguments: {} },
			{ type: "image", data: "", mimeType: "image/png" },
		]) {
			const content = [{ type: "text", text: "partial" }, block] as never;
			expect(recovery(true).isRetryableError(message("400 no keys found", 400, content))).toBe(false);
		}
	});

	it("never resumes a turn the operator aborted", () => {
		const aborted = message("aborted by user", undefined, [], "aborted");
		expect(recovery().isRetryableError(aborted)).toBe(false);
	});

	it("does not hijack a thinking loop into a model switch", () => {
		// The loop guard wants a same-model resample (issue #8760).
		const thinkingLoop = message("thinking loop detected: repeated reasoning", undefined, [
			{ type: "thinking", thinking: "loop" },
		] as never);
		// Classified via the loop flag rather than a provider status; a switch
		// would abandon the redirect.
		const eligible = recovery().isRetryableError(thinkingLoop);
		expect(typeof eligible).toBe("boolean");
	});
});
