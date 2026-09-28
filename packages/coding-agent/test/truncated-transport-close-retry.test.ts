/**
 * A stream cut mid-flight leaves a FRAGMENT, so it may be retried — and its
 * configured fallback chain must be reachable.
 *
 * The committed-text veto (`#hasReplayUnsafeOutput`) exists so a replay cannot
 * show the user the same finished answer twice. It does not hold when the
 * transport died mid-stream: the turn ends `stopReason: "error"`, the visible
 * text stops mid-sentence, and nothing usable was produced. Refusing to retry
 * there threw away the whole turn to avoid duplicating a partial paragraph, and
 * it silently bypassed the fallback chain — reported as
 * `azure1-bitfrost/openai/gpt-6-astra` dying with "The socket connection was
 * closed unexpectedly." after streaming a few hundred characters, with three
 * `azure1-bitfrost/*` fallbacks configured and none attempted.
 *
 * The carve-out stays narrow: tool calls, images and server-tool blocks keep
 * the veto (side effects), and a turn that stopped for any non-error reason is
 * a complete answer.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
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

const SOCKET_CLOSED = "The socket connection was closed unexpectedly.";

describe("truncated transport close is replay-safe", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-transport-close-");
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

	/** `textOutputCommitted` true = the text already rendered for the user. */
	function recovery(): TurnRecovery {
		const host = {
			settings: Settings.isolated({}),
			modelRegistry,
			model: () => model,
			configWarnings: [],
			agent: { state: { messages: [] } },
			sessionId: () => "transport-close-session",
			textOutputCommitted: () => true,
			contextFitsModel: () => true,
		} as unknown as TurnRecoveryHost;
		return new TurnRecovery(host);
	}

	function message(
		content: AssistantMessage["content"],
		options: { errorMessage?: string; stopReason?: AssistantMessage["stopReason"] } = {},
	): AssistantMessage {
		return {
			role: "assistant",
			content,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { ...USAGE },
			stopReason: options.stopReason ?? "error",
			errorMessage: options.errorMessage ?? SOCKET_CLOSED,
			timestamp: Date.now(),
		} as AssistantMessage;
	}

	const truncatedText = [{ type: "text", text: "Measured login popup: 14 px left, right, and bo" }] as never;

	it("retries a turn whose committed text was cut by a socket close", () => {
		expect(recovery().isRetryableError(message(truncatedText))).toBe(true);
	});

	it("covers the transport-close wordings the error classifier recognizes", () => {
		// The carve-out lifts only the REPLAY veto. Retriability still comes from
		// `AIError.classifyMessage`, so a wording the classifier does not know
		// stays non-retryable — the session layer must not invent retriability.
		for (const error of ["The socket connection was closed unexpectedly.", "socket hang up"]) {
			expect(recovery().isRetryableError(message(truncatedText, { errorMessage: error }))).toBe(true);
		}
	});

	it("does not claim an unclassified transport wording as a truncated close", () => {
		// `read ECONNRESET` and friends classify as unknown (id 0), so the
		// carve-out itself does not fire — the AI-layer classifier is the right
		// place to fix that. They are still recoverable overall, because every
		// provider failure now earns the fallback chain.
		for (const error of ["read ECONNRESET", "Premature close", "stream closed before completion"]) {
			const failed = message(truncatedText, { errorMessage: error });
			expect(AIError.retriable(AIError.classifyMessage(failed))).toBe(false);
			expect(recovery().isRetryableError(failed)).toBe(true);
		}
	});

	it("keeps the veto for a completed turn", () => {
		// Not an error stop: this is a finished answer, replaying it would show
		// the user the same text twice.
		expect(recovery().isRetryableError(message(truncatedText, { stopReason: "stop", errorMessage: undefined }))).toBe(
			false,
		);
	});

	it("keeps the veto when a tool call is present", () => {
		const withToolCall = [
			{ type: "text", text: "partial text" },
			{ type: "toolCall", id: "call-1", name: "bash", arguments: {} },
		] as never;
		expect(recovery().isRetryableError(message(withToolCall))).toBe(false);
	});

	it("keeps the veto when an image was generated", () => {
		const withImage = [
			{ type: "text", text: "partial text" },
			{ type: "image", data: "", mimeType: "image/png" },
		] as never;
		expect(recovery().isRetryableError(message(withImage))).toBe(false);
	});

	it("does not classify a non-transport error as a truncated close", () => {
		// A parameter rejection is not a cut stream. It is still fallback-eligible
		// (another route may accept the request), just not via this carve-out.
		const failed = message(truncatedText, {
			errorMessage: "400 invalid_request_error: unsupported parameter",
		});
		expect(AIError.retriable(AIError.classifyMessage(failed))).toBe(false);
		expect(recovery().isRetryableError(failed)).toBe(true);
	});

	it("still allows thinking-only partials, which were never vetoed", () => {
		const thinkingOnly = [{ type: "thinking", thinking: "considering the layout" }] as never;
		expect(recovery().isRetryableError(message(thinkingOnly))).toBe(true);
	});
});
