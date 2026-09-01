/**
 * `retry_fallback_applied` carries the provider error that triggered the swap.
 *
 * Regression: the notice rendered as a bare `Fallback: A -> B`, so an operator
 * watching a batch of proxies had no way to tell an auth failure from a quota
 * cooldown, a rate limit, or an unsupported-parameter rejection — the reason
 * only existed inside the session log.
 */
import { describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { describeFallbackReason } from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("describeFallbackReason", () => {
	it("flattens a multi-line provider error to one line", () => {
		expect(
			describeFallbackReason(
				"litellm.UnsupportedParamsError: openrouter does not support parameters: ['reasoning_effort']\n\nAvailable Model Group Fallbacks=None",
			),
		).toBe(
			"litellm.UnsupportedParamsError: openrouter does not support parameters: ['reasoning_effort'] Available Model Group Fallbacks=None",
		);
	});

	it("truncates a long error so the notice stays one line", () => {
		const reason = describeFallbackReason("x".repeat(500));
		expect(reason).toHaveLength(160);
		expect(reason?.endsWith("…")).toBe(true);
	});

	it("returns undefined for missing or blank errors", () => {
		expect(describeFallbackReason(undefined)).toBeUndefined();
		expect(describeFallbackReason("")).toBeUndefined();
		expect(describeFallbackReason("   \n  ")).toBeUndefined();
	});
});

describe("fallback notice rendering", () => {
	async function renderNotice(event: Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>) {
		await initTheme(false);
		const warnings: string[] = [];
		const ctx = {
			isInitialized: true,
			init: async () => {},
			statusLine: { invalidate: vi.fn(), markActivityStart: vi.fn(), markActivityEnd: vi.fn() },
			showWarning: (message: string) => warnings.push(message),
			showStatus: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new EventController(ctx);
		await controller.handleEvent(event);
		return warnings;
	}

	it("names the trigger next to the model swap", async () => {
		const warnings = await renderNotice({
			type: "retry_fallback_applied",
			from: "mammouth-vuln/kimi-k3:high",
			to: "entrim-ai-vuln/deepseek-ai/DeepSeek-V4-Flash",
			role: "default",
			reason: "429 All 3 tokens are in cooldown. Next available in 657.5s",
		});

		expect(Bun.stripANSI(warnings[0] ?? "")).toBe(
			"Fallback: mammouth-vuln/kimi-k3:high -> entrim-ai-vuln/deepseek-ai/DeepSeek-V4-Flash — " +
				"429 All 3 tokens are in cooldown. Next available in 657.5s",
		);
	});

	it("keeps the old shape when no reason is known", async () => {
		const warnings = await renderNotice({
			type: "retry_fallback_applied",
			from: "a/one",
			to: "b/two",
			role: "default",
		});
		expect(Bun.stripANSI(warnings[0] ?? "")).toBe("Fallback: a/one -> b/two");
	});
});

describe("session emits the triggering error", () => {
	it("carries the provider error on the applied event", async () => {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = getBundledModel("google", "gemini-2.5-flash");
		if (!primary || !fallback) throw new Error("Expected bundled fallback models");

		const tempDir = TempDir.createSync("@pi-fallback-reason-");
		const authStorage = await AuthStorage.create(`${tempDir.path()}/auth.db`);
		authStorage.setRuntimeApiKey("anthropic", "key-a");
		authStorage.setRuntimeApiKey("google", "key-b");
		const modelRegistry = new ModelRegistry(authStorage);
		const primarySelector = `${primary.provider}/${primary.id}`;
		const fallbackSelector = `${fallback.provider}/${fallback.id}`;
		const providerError =
			"litellm.UnsupportedParamsError: openrouter does not support parameters: ['reasoning_effort'],\nfor model=deepseek/deepseek-v4-flash.";

		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				if (`${model.provider}/${model.id}` === primarySelector) {
					mock.push({ stopReason: "error", errorMessage: providerError });
				} else {
					mock.push({ content: ["recovered"] });
				}
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": { default: [fallbackSelector] },
		});
		settings.setModelRole("default", primarySelector);

		const applied: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") applied.push(event);
		});

		try {
			await session.prompt("trigger the fallback");
			await session.waitForIdle();

			expect(applied).toHaveLength(1);
			expect(applied[0]?.from).toBe(primarySelector);
			expect(applied[0]?.to).toBe(fallbackSelector);
			// One line, provider text preserved, newline collapsed.
			expect(applied[0]?.reason).toContain("does not support parameters: ['reasoning_effort']");
			expect(applied[0]?.reason).not.toContain("\n");
		} finally {
			await session.dispose();
			authStorage.close();
			await tempDir.remove().catch(() => {});
		}
	}, 60_000);
});
