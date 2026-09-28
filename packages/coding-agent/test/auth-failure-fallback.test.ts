/**
 * An auth failure moves the work to another provider instead of ending the turn.
 *
 * `401 User not found.` from a gateway whose key was revoked classified as
 * `AuthFailed` and non-retriable, so the turn died even with healthy providers
 * configured in `retry.fallbackChains`. A dead credential is terminal for that
 * credential, not for the work.
 *
 * The retry is deliberately NOT a same-credential sleep-and-retry (a revoked
 * key does not heal): recovery rotates to a sibling credential, else the chain
 * switches model, else the saga closes without looping.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Model, Usage } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
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

const AUTH_ERROR = "401 User not found.\nUser not found. (type=401)";

describe("auth failure is recoverable", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let primary: Model;
	let fallback: Model;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-auth-fallback-");
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		for (const provider of ["anthropic", "openai"]) {
			authStorage.keys.setRuntime(provider, "test-key");
		}
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const p = getBundledModel("anthropic", "claude-sonnet-4-5");
		const f = getBundledModel("openai", "gpt-4o-mini");
		if (!p || !f) throw new Error("expected bundled models");
		primary = p;
		fallback = f;
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		modelRegistry.clearSuppressedSelectors();
	});

	afterAll(() => {
		AgentStorage.close();
		authStorage.close();
		tempDir.removeSync();
	});

	function message(errorMessage: string, errorStatus: number): AssistantMessage {
		return {
			role: "assistant",
			content: [],
			api: primary.api,
			provider: primary.provider,
			model: primary.id,
			usage: { ...USAGE },
			stopReason: "error",
			errorMessage,
			errorStatus,
			timestamp: Date.now(),
		} as AssistantMessage;
	}

	function recovery(): TurnRecovery {
		const host = {
			settings: Settings.isolated({}),
			modelRegistry,
			model: () => primary,
			configWarnings: [],
			agent: { state: { messages: [] } },
			sessionId: () => "auth-failure-session",
			textOutputCommitted: () => true,
			contextFitsModel: () => true,
		} as unknown as TurnRecoveryHost;
		return new TurnRecovery(host);
	}

	it("classifies 401 and 403 as retryable so recovery runs", () => {
		expect(recovery().isRetryableError(message(AUTH_ERROR, 401))).toBe(true);
		expect(recovery().isRetryableError(message("403 Forbidden", 403))).toBe(true);
	});

	it("switches to the configured fallback provider and finishes the work", async () => {
		const requestedModels: string[] = [];
		const mock = createMockModel();
		let primaryAttempts = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.provider === primary.provider && primaryAttempts === 0) {
					primaryAttempts += 1;
					mock.push({ throw: AUTH_ERROR });
				} else {
					mock.push({ content: [`ok:${model.provider}/${model.id}`] });
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 2,
			"retry.fallbackChains": {
				[`${primary.provider}/${primary.id}`]: [`${fallback.provider}/${fallback.id}`],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("A revoked key must not stop the work");
		await session.waitForIdle();

		// The work continued on the fallback provider rather than dying on 401.
		expect(requestedModels[0]).toBe(`${primary.provider}/${primary.id}`);
		expect(requestedModels).toContain(`${fallback.provider}/${fallback.id}`);
		expect(session.model?.id).toBe(fallback.id);
	});

	it("does not sleep-and-retry the same dead credential", async () => {
		const requestedModels: string[] = [];
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				mock.push({ throw: AUTH_ERROR });
				return mock.stream(model, context, options);
			},
		});

		// No chain, no sibling credential: the saga must close instead of
		// burning the retry budget against a key that cannot heal.
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 3,
			"retry.fallbackChains": {},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("No sibling, no chain");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${primary.provider}/${primary.id}`]);
	});
});
