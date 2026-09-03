/**
 * Regression: a compaction summary rejected with a provider budget/quota error
 * ended the whole compaction —
 *
 *   Compaction failed: Short summary failed: 429 ExceededBudget:
 *   User=512837 over budget. Spend=15.0, Budget=15.0
 *
 * — even though the session had other authenticated models available. The
 * manual `/compact` path advanced to the next candidate only for AuthFailed,
 * so the first exhausted credential was terminal. A usage limit is exactly as
 * model-local as an auth failure: retrying the same model cannot help, the
 * next candidate is the only move.
 *
 * Second half of the fix: candidates now include the models named by
 * `retry.fallbackChains`, not just role assignments — the user's explicit
 * "when this model fails, use these" list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { assistantMsg, userMsg } from "./utilities";

const BUDGET_ERROR =
	"Short summary failed: 429 ExceededBudget: User=512837 over budget. Spend=15.0, Budget=15.0 (type=budget_exceeded param=429)";

describe("compaction fallback on provider budget exhaustion", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-compaction-budget-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) await session.dispose();
		authStorage?.close();
		tempDir.removeSync();
	});

	async function createSession(options?: { via: "role" | "chain" }) {
		const exhausted = getBundledModel("openai", "gpt-5.6-sol");
		const spare = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!exhausted || !spare) throw new Error("Expected bundled test models to exist");

		const settings = Settings.isolated({
			"compaction.keepRecentTokens": 1,
			"compaction.methodOrder": ["soft"],
		});
		if (options?.via === "chain") {
			// No role points anywhere useful; only the fallback chain names the spare.
			settings.set("retry.fallbackChains", {
				[`${exhausted.provider}/${exhausted.id}`]: [`${spare.provider}/${spare.id}`],
			});
		} else if (options?.via === "role") {
			settings.setModelRole("smol", `${spare.provider}/${spare.id}`);
		}

		const agent = new Agent({
			initialState: { model: exhausted, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey(exhausted.provider, "openai-token");
		authStorage.setRuntimeApiKey(spare.provider, "anthropic-token");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([exhausted, spare]);
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(() => {});
		for (const [userText, assistantText] of [
			["first question", "first answer"],
			["second question", "second answer"],
		] as const) {
			const user = userMsg(userText);
			const assistant = assistantMsg(assistantText);
			session.agent.appendMessage(user);
			session.sessionManager.appendMessage(user);
			session.agent.appendMessage(assistant);
			session.sessionManager.appendMessage(assistant);
		}
		return { exhausted, spare };
	}

	function budgetThenSucceed(exhaustedProvider: string) {
		const attempted: string[] = [];
		const spy = vi.spyOn(compactionModule, "compact").mockImplementation(async (_prep, model) => {
			attempted.push(`${model.provider}/${model.id}`);
			if (model.provider === exhaustedProvider) {
				const error = new Error(BUDGET_ERROR) as Error & { status?: number };
				error.status = 429;
				throw error;
			}
			return {
				summary: "summary from the spare model",
				shortSummary: "spare summary",
				firstKeptEntryId: undefined,
				tokensBefore: 100,
				details: undefined,
				preserveData: undefined,
			} as never;
		});
		return { attempted, spy };
	}

	it("moves to the role-assigned model when the current one is over budget", async () => {
		const { exhausted } = await createSession({ via: "role" });
		const { attempted } = budgetThenSucceed(exhausted.provider);

		const result = await session.compact();

		expect(result).toBeDefined();
		// The exhausted model is tried first, then abandoned — not rethrown.
		expect(attempted[0]).toBe(`${exhausted.provider}/${exhausted.id}`);
		expect(attempted.length).toBeGreaterThan(1);
		expect(attempted.at(-1)).toContain("anthropic/");
	});

	it("moves to a retry.fallbackChains model when no role offers one", async () => {
		const { exhausted, spare } = await createSession({ via: "chain" });
		const { attempted } = budgetThenSucceed(exhausted.provider);

		const result = await session.compact();

		expect(result).toBeDefined();
		expect(attempted).toContain(`${spare.provider}/${spare.id}`);
	});

	it("falls through the method order so a provider-pinned remote 429 still reaches another provider", async () => {
		// Advisory check: `remote` pins candidates to the current provider
		// (provider-native compaction only exists there), so a provider-wide
		// 429 cannot rotate WITHIN that method. It must escape via the method
		// order instead — remote fails, `soft` runs with an unfiltered
		// candidate list, and the spare provider summarizes.
		const exhausted = getBundledModel("openai", "gpt-5");
		const spare = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!exhausted || !spare) throw new Error("Expected bundled test models to exist");

		const settings = Settings.isolated({
			"compaction.keepRecentTokens": 1,
			"compaction.methodOrder": ["remote", "soft"],
		});
		settings.setModelRole("smol", `${spare.provider}/${spare.id}`);
		const agent = new Agent({
			initialState: { model: exhausted, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey(exhausted.provider, "openai-token");
		authStorage.setRuntimeApiKey(spare.provider, "anthropic-token");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([exhausted, spare]);
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(() => {});
		for (const [userText, assistantText] of [
			["first question", "first answer"],
			["second question", "second answer"],
		] as const) {
			const user = userMsg(userText);
			const assistant = assistantMsg(assistantText);
			session.agent.appendMessage(user);
			session.sessionManager.appendMessage(user);
			session.agent.appendMessage(assistant);
			session.sessionManager.appendMessage(assistant);
		}

		const { attempted } = budgetThenSucceed(exhausted.provider);
		const result = await session.compact();

		expect(result).toBeDefined();
		expect(attempted).toContain(`${spare.provider}/${spare.id}`);
	});

	it("reports the budget error, not a credentials error, when every candidate is exhausted", async () => {
		await createSession({ via: "role" });
		vi.spyOn(compactionModule, "compact").mockImplementation(async () => {
			const error = new Error(BUDGET_ERROR) as Error & { status?: number };
			error.status = 429;
			throw error;
		});

		const failure = await session.compact().then(
			() => undefined,
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(Error);
		// The old tail threw #buildCompactionAuthError, blaming credentials for
		// what is actually a spend cap.
		expect((failure as Error).message).toContain("ExceededBudget");
		expect((failure as Error).message).not.toContain("Configure");
	});
});
