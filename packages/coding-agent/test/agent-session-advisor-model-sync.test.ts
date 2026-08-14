/**
 * Contract tests for the AgentSession advisor+profile sync surface:
 *
 *   #2 `refreshAdvisors()`      — force-rebuild advisor runtime from current
 *                                 settings (profile switch rewrites
 *                                 `modelRoles.advisor` but leaves live agents
 *                                 pinned to the old model).
 *   #3 `ensureAdvisorsBuilt()`  — idempotent build-if-missing. Retries the
 *                                 first advisor build that was skipped because
 *                                 the configured advisor-role model was not
 *                                 yet in the registry.
 *   #4 late-provider-load race  — INTEGRATION: adding a runtime API key +
 *                                 `modelRegistry.refresh()` fires
 *                                 `onModelsUpdated`, which the session's
 *                                 constructor wires to
 *                                 `ensureAdvisorsBuilt()`; the advisor
 *                                 auto-activates without an explicit rebuild.
 *   #5 `applyProfileToSession()` — apply the active profile's model roles +
 *                                 thinking level to a live session (primary
 *                                 model via `default` role, `defaultThinkingLevel`,
 *                                 advisor rebuild). An unresolvable `default`
 *                                 role rejects before any partial runtime apply,
 *                                 preventing profile/header model divergence.
 *
 * The reference harness (real ModelRegistry(authStorage) + new AgentSession)
 * mirrors `advisor-toggle.test.ts` and `model-registry-models-updated.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { type GeneratedProvider, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { deleteProfile, getActiveProfileName, switchProfile } from "@oh-my-pi/pi-coding-agent/config/profiles";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

// Provider fixtures — kept as literal strings so an assertion failure names the
// concrete id (not an interpolated variable) in the diff.
const PRIMARY_PROVIDER = "anthropic";
const PRIMARY_MODEL_ID = "claude-sonnet-4-5"; // model A
const SWAP_MODEL_ID = "claude-haiku-4-5"; // model B (same provider, so one key covers both)
// `kimi-code` is intentionally chosen over `openai` for the late-load slot: it
// has no env-var fallback in `serviceProviderMap`, so `authStorage.hasAuth`
// returns false deterministically until a runtime key is installed. Openai
// would inherit `OPENAI_API_KEY` from a developer's shell and undo the
// initially-unavailable setup for #3 and #4.
const LATE_PROVIDER = "kimi-code";
const LATE_MODEL_ID = "kimi-for-coding"; // model C — held back by missing runtime key

function getModelOrThrow(provider: GeneratedProvider, id: string): Model {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected bundled model ${provider}/${id}`);
	return model;
}

interface HarnessOptions {
	settingsOverrides: Partial<Record<string, unknown>>;
	credentialedProviders: readonly string[];
	settings?: Settings;
}

interface Harness {
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	sessionManager: SessionManager;
	settings: Settings;
	session: AgentSession;
	tempDir: TempDir;
	dispose: () => Promise<void>;
}

describe("AgentSession advisor + profile model sync", () => {
	// Each test builds a self-contained harness so credential state, model
	// registries, and session-managed temp files never leak between contracts.
	const harnesses: Harness[] = [];

	async function createHarness(opts: HarnessOptions): Promise<Harness> {
		const tempDir = TempDir.createSync("@pi-advisor-model-sync-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		for (const provider of opts.credentialedProviders) {
			authStorage.setRuntimeApiKey(provider, `${provider}-test-key`);
		}
		const modelRegistry = new ModelRegistry(authStorage);
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const settings =
			opts.settings ??
			Settings.isolated({
				"compaction.enabled": false,
				...opts.settingsOverrides,
			});
		const primaryModel = getModelOrThrow(PRIMARY_PROVIDER, PRIMARY_MODEL_ID);
		const agent = new Agent({
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			advisorTools: [],
		});
		const harness: Harness = {
			authStorage,
			modelRegistry,
			sessionManager,
			settings,
			session,
			tempDir,
			dispose: async () => {
				await session.dispose();
				authStorage.close();
				try {
					await tempDir.remove();
				} catch {}
			},
		};
		harnesses.push(harness);
		return harness;
	}

	afterEach(async () => {
		while (harnesses.length > 0) {
			const h = harnesses.pop()!;
			try {
				await h.dispose();
			} catch {}
		}
	});

	// ═════════════════════════════════════════════════════════════════════
	// Contract #2 — refreshAdvisors()
	// ═════════════════════════════════════════════════════════════════════

	describe("refreshAdvisors()", () => {
		it("rebuilds an active advisor onto the newly-configured advisor-role model", async () => {
			// Build with advisor enabled + configured to model A (same provider as
			// the primary so a single runtime key covers both).
			const { session } = await createHarness({
				settingsOverrides: {
					"advisor.enabled": true,
					modelRoles: {
						default: `${PRIMARY_PROVIDER}/${PRIMARY_MODEL_ID}`,
						advisor: `${PRIMARY_PROVIDER}/${PRIMARY_MODEL_ID}`,
					},
				},
				credentialedProviders: [PRIMARY_PROVIDER],
			});
			expect(session.isAdvisorActive()).toBe(true);
			expect(session.getAdvisorAgent()?.state.model?.id).toBe(PRIMARY_MODEL_ID);

			// Rewrite `modelRoles.advisor` to model B — the live advisor is still
			// pinned to model A until refreshAdvisors() re-resolves the role.
			session.settings.setModelRole("advisor", `${PRIMARY_PROVIDER}/${SWAP_MODEL_ID}`);

			const rebuilt = session.refreshAdvisors();
			expect(rebuilt).toBe(1);
			expect(session.isAdvisorActive()).toBe(true);
			const advisorAgent = session.getAdvisorAgent();
			expect(advisorAgent?.state.model?.id).toBe(SWAP_MODEL_ID);
			expect(advisorAgent?.state.model?.provider).toBe(PRIMARY_PROVIDER);
		});

		it("returns 0 no-op when the advisor is disabled", async () => {
			const { session } = await createHarness({
				// advisor.enabled defaults to false, so we omit the override here.
				settingsOverrides: {
					modelRoles: {
						default: `${PRIMARY_PROVIDER}/${PRIMARY_MODEL_ID}`,
						advisor: `${PRIMARY_PROVIDER}/${PRIMARY_MODEL_ID}`,
					},
				},
				credentialedProviders: [PRIMARY_PROVIDER],
			});
			expect(session.isAdvisorEnabled()).toBe(false);
			expect(session.isAdvisorActive()).toBe(false);

			// Even a role rewrite should not spin the advisor up here — that path
			// is reserved for setAdvisorEnabled / toggleAdvisorEnabled.
			session.settings.setModelRole("advisor", `${PRIMARY_PROVIDER}/${SWAP_MODEL_ID}`);
			expect(session.refreshAdvisors()).toBe(0);
			expect(session.isAdvisorActive()).toBe(false);
			expect(session.getAdvisorAgent()).toBeUndefined();
		});

		it("returns 0 no-op when the advisor is enabled but no advisor is currently active", async () => {
			// Enabled + advisor role points to a provider whose credential is not
			// installed → the initial build silently skips, leaving no live agent
			// for refreshAdvisors() to refresh.
			const { session } = await createHarness({
				settingsOverrides: {
					"advisor.enabled": true,
					modelRoles: {
						default: `${PRIMARY_PROVIDER}/${PRIMARY_MODEL_ID}`,
						advisor: `${LATE_PROVIDER}/${LATE_MODEL_ID}`,
					},
				},
				credentialedProviders: [PRIMARY_PROVIDER],
			});
			expect(session.isAdvisorEnabled()).toBe(true);
			expect(session.isAdvisorActive()).toBe(false);

			expect(session.refreshAdvisors()).toBe(0);
			expect(session.isAdvisorActive()).toBe(false);
			expect(session.getAdvisorAgent()).toBeUndefined();
		});
	});

	// ═════════════════════════════════════════════════════════════════════
	// Contract #3 — ensureAdvisorsBuilt()
	// ═════════════════════════════════════════════════════════════════════

	describe("ensureAdvisorsBuilt()", () => {
		it("activates the advisor with its configured model once the model becomes available", async () => {
			// advisor.enabled + advisor role targets `openai/gpt-4o-mini`, but the
			// openai runtime key is deliberately withheld → initial build skips.
			const { session, authStorage } = await createHarness({
				settingsOverrides: {
					"advisor.enabled": true,
					modelRoles: {
						default: `${PRIMARY_PROVIDER}/${PRIMARY_MODEL_ID}`,
						advisor: `${LATE_PROVIDER}/${LATE_MODEL_ID}`,
					},
				},
				credentialedProviders: [PRIMARY_PROVIDER],
			});
			expect(session.isAdvisorEnabled()).toBe(true);
			expect(session.isAdvisorActive()).toBe(false);
			expect(session.getAdvisorAgent()).toBeUndefined();

			// Install the missing credential; ensureAdvisorsBuilt() retries the build.
			authStorage.setRuntimeApiKey(LATE_PROVIDER, `${LATE_PROVIDER}-test-key`);
			const built = session.ensureAdvisorsBuilt();
			expect(built).toBe(true);
			expect(session.isAdvisorActive()).toBe(true);
			const advisorAgent = session.getAdvisorAgent();
			expect(advisorAgent?.state.model?.id).toBe(LATE_MODEL_ID);
			expect(advisorAgent?.state.model?.provider).toBe(LATE_PROVIDER);
		});

		it("returns true idempotently when an advisor is already active (no rebuild)", async () => {
			const { session } = await createHarness({
				settingsOverrides: {
					"advisor.enabled": true,
					modelRoles: {
						default: `${PRIMARY_PROVIDER}/${PRIMARY_MODEL_ID}`,
						advisor: `${PRIMARY_PROVIDER}/${PRIMARY_MODEL_ID}`,
					},
				},
				credentialedProviders: [PRIMARY_PROVIDER],
			});
			expect(session.isAdvisorActive()).toBe(true);
			const before = session.getAdvisorAgent();
			expect(before?.state.model?.id).toBe(PRIMARY_MODEL_ID);

			expect(session.ensureAdvisorsBuilt()).toBe(true);
			// Same live Agent instance — no rebuild happened.
			expect(session.getAdvisorAgent()).toBe(before);
		});

		it("returns false when the advisor setting is disabled", async () => {
			const { session } = await createHarness({
				// advisor.enabled defaults to false, so we omit the override here.
				settingsOverrides: {
					modelRoles: {
						default: `${PRIMARY_PROVIDER}/${PRIMARY_MODEL_ID}`,
						advisor: `${PRIMARY_PROVIDER}/${PRIMARY_MODEL_ID}`,
					},
				},
				credentialedProviders: [PRIMARY_PROVIDER],
			});
			expect(session.isAdvisorEnabled()).toBe(false);
			expect(session.ensureAdvisorsBuilt()).toBe(false);
			expect(session.isAdvisorActive()).toBe(false);
			expect(session.getAdvisorAgent()).toBeUndefined();
		});
	});

	// ═════════════════════════════════════════════════════════════════════
	// Contract #4 — late-provider-load race (integration)
	// ═════════════════════════════════════════════════════════════════════

	describe("late-provider-load race", () => {
		it("auto-activates a configured-but-unavailable advisor once a runtime key + modelRegistry.refresh() arrive — no explicit rebuild", async () => {
			// Same starting state as the #3 primary test: enabled, advisor role
			// pinned to openai/gpt-4o-mini, no openai credential → inactive.
			const { session, authStorage, modelRegistry } = await createHarness({
				settingsOverrides: {
					"advisor.enabled": true,
					modelRoles: {
						default: `${PRIMARY_PROVIDER}/${PRIMARY_MODEL_ID}`,
						advisor: `${LATE_PROVIDER}/${LATE_MODEL_ID}`,
					},
				},
				credentialedProviders: [PRIMARY_PROVIDER],
			});
			expect(session.isAdvisorActive()).toBe(false);
			expect(session.getAdvisorAgent()).toBeUndefined();

			// Add the runtime key, then let refresh() fire onModelsUpdated. The
			// session's constructor subscribes ensureAdvisorsBuilt() to that
			// event — we intentionally DO NOT call ensureAdvisorsBuilt() here.
			authStorage.setRuntimeApiKey(LATE_PROVIDER, `${LATE_PROVIDER}-test-key`);
			await modelRegistry.refresh();

			expect(session.isAdvisorActive()).toBe(true);
			const advisorAgent = session.getAdvisorAgent();
			expect(advisorAgent?.state.model?.id).toBe(LATE_MODEL_ID);
			expect(advisorAgent?.state.model?.provider).toBe(LATE_PROVIDER);
		});
	});

	// ═════════════════════════════════════════════════════════════════════
	// Contract #5 — applyProfileToSession()
	// ═════════════════════════════════════════════════════════════════════

	describe("applyProfileToSession()", () => {
		it("applies the default-role model, defaultThinkingLevel, and rebuilds the advisor onto the profile's advisor-role model", async () => {
			// Boot with primary=A / advisor=A so we can observe all three
			// coordinates change in a single applyProfileToSession() call:
			// primary → model B, thinking → high, advisor → model C (openai).
			const { session } = await createHarness({
				settingsOverrides: {
					"advisor.enabled": true,
					modelRoles: {
						default: `${PRIMARY_PROVIDER}/${PRIMARY_MODEL_ID}`,
						advisor: `${PRIMARY_PROVIDER}/${PRIMARY_MODEL_ID}`,
					},
				},
				credentialedProviders: [PRIMARY_PROVIDER, LATE_PROVIDER],
			});
			expect(session.model?.id).toBe(PRIMARY_MODEL_ID);
			expect(session.getAdvisorAgent()?.state.model?.id).toBe(PRIMARY_MODEL_ID);

			// Simulate a `/profiles switch` writing the profile's snapshot into
			// live settings, then dispatching applyProfileToSession().
			session.settings.setModelRole("default", `${PRIMARY_PROVIDER}/${SWAP_MODEL_ID}`);
			session.settings.set("defaultThinkingLevel", Effort.High);
			session.settings.setModelRole("advisor", `${LATE_PROVIDER}/${LATE_MODEL_ID}`);

			await session.applyProfileToSession();

			expect(session.model?.id).toBe(SWAP_MODEL_ID);
			expect(session.model?.provider).toBe(PRIMARY_PROVIDER);
			expect(session.thinkingLevel).toBe(Effort.High);
			const advisorAgent = session.getAdvisorAgent();
			expect(advisorAgent?.state.model?.id).toBe(LATE_MODEL_ID);
			expect(advisorAgent?.state.model?.provider).toBe(LATE_PROVIDER);
		});

		it("rejects an unresolvable default-role model before changing the primary model or thinking", async () => {
			const { session } = await createHarness({
				settingsOverrides: {
					"advisor.enabled": true,
					modelRoles: {
						default: `${PRIMARY_PROVIDER}/${PRIMARY_MODEL_ID}`,
						advisor: `${PRIMARY_PROVIDER}/${PRIMARY_MODEL_ID}`,
					},
				},
				credentialedProviders: [PRIMARY_PROVIDER],
			});
			const previousThinking = session.thinkingLevel;

			session.settings.setModelRole("default", "bogus-provider/nonexistent-model");
			session.settings.set("defaultThinkingLevel", Effort.Low);
			session.settings.setModelRole("advisor", `${PRIMARY_PROVIDER}/${SWAP_MODEL_ID}`);

			await expect(session.applyProfileToSession()).rejects.toThrow(
				'Profile default model "bogus-provider/nonexistent-model" is unavailable',
			);
			expect(session.model?.id).toBe(PRIMARY_MODEL_ID);
			expect(session.thinkingLevel).toBe(previousThinking);
		});

		it("preflights an unavailable advisor before changing the live primary model or thinking", async () => {
			const { session } = await createHarness({
				settingsOverrides: {
					"advisor.enabled": true,
					modelRoles: {
						default: `${PRIMARY_PROVIDER}/${PRIMARY_MODEL_ID}`,
						advisor: `${PRIMARY_PROVIDER}/${PRIMARY_MODEL_ID}`,
					},
				},
				credentialedProviders: [PRIMARY_PROVIDER],
			});
			const previousThinking = session.thinkingLevel;
			session.settings.setModelRole("default", `${PRIMARY_PROVIDER}/${SWAP_MODEL_ID}`);
			session.settings.set("defaultThinkingLevel", Effort.High);
			session.settings.setModelRole("advisor", `${LATE_PROVIDER}/${LATE_MODEL_ID}`);

			await expect(session.applyProfileToSession()).rejects.toThrow(
				`Profile advisor model "${LATE_PROVIDER}/${LATE_MODEL_ID}" is unavailable`,
			);
			expect(session.model?.id).toBe(PRIMARY_MODEL_ID);
			expect(session.thinkingLevel).toBe(previousThinking);
		});

		it("restores the previous live model when setModel throws after mutating agent state", async () => {
			const { session } = await createHarness({
				settingsOverrides: {
					modelRoles: { default: `${PRIMARY_PROVIDER}/${PRIMARY_MODEL_ID}` },
				},
				credentialedProviders: [PRIMARY_PROVIDER],
			});
			vi.spyOn(session, "setModel").mockImplementationOnce(async model => {
				session.agent.setModel(model);
				throw new Error("injected model apply failure");
			});
			session.settings.setModelRole("default", `${PRIMARY_PROVIDER}/${SWAP_MODEL_ID}`);

			await expect(session.applyProfileToSession()).rejects.toThrow("injected model apply failure");
			expect(session.model?.id).toBe(PRIMARY_MODEL_ID);
		});

		describe("profile CRUD to live-session integration", () => {
			it("switches the live primary model to the selected profile model", async () => {
				resetSettingsForTest();
				await Settings.init({ inMemory: true });
				const settings = Settings.instance;
				settings.set("profiles.items", {
					first: {
						modelRoles: { default: `${PRIMARY_PROVIDER}/${PRIMARY_MODEL_ID}` },
						defaultThinkingLevel: "medium",
					},
					second: {
						modelRoles: { default: `${PRIMARY_PROVIDER}/${SWAP_MODEL_ID}` },
						defaultThinkingLevel: "high",
					},
				});
				settings.set("profiles.active", "first");
				settings.set("modelRoles", { default: `${PRIMARY_PROVIDER}/${PRIMARY_MODEL_ID}` });
				const { session } = await createHarness({
					settingsOverrides: {},
					credentialedProviders: [PRIMARY_PROVIDER],
					settings,
				});

				switchProfile("second");
				await session.applyProfileToSession();

				expect(getActiveProfileName()).toBe("second");
				expect(settings.get("modelRoles").default).toBe(`${PRIMARY_PROVIDER}/${SWAP_MODEL_ID}`);
				expect(session.model?.provider).toBe(PRIMARY_PROVIDER);
				expect(session.model?.id).toBe(SWAP_MODEL_ID);
				expect(session.thinkingLevel).toBe(Effort.High);
			});

			it("deleting the selected profile switches the live model to its deterministic fallback", async () => {
				resetSettingsForTest();
				await Settings.init({ inMemory: true });
				const settings = Settings.instance;
				settings.set("profiles.items", {
					selected: {
						modelRoles: { default: `${PRIMARY_PROVIDER}/${PRIMARY_MODEL_ID}` },
						defaultThinkingLevel: "medium",
					},
					fallback: {
						modelRoles: { default: `${PRIMARY_PROVIDER}/${SWAP_MODEL_ID}` },
						defaultThinkingLevel: "high",
					},
				});
				settings.set("profiles.active", "selected");
				settings.set("modelRoles", { default: `${PRIMARY_PROVIDER}/${PRIMARY_MODEL_ID}` });
				const { session } = await createHarness({
					settingsOverrides: {},
					credentialedProviders: [PRIMARY_PROVIDER],
					settings,
				});

				const result = deleteProfile("selected");
				expect(result.activated?.name).toBe("fallback");
				await session.applyProfileToSession();

				expect(getActiveProfileName()).toBe("fallback");
				expect(session.model?.provider).toBe(PRIMARY_PROVIDER);
				expect(session.model?.id).toBe(SWAP_MODEL_ID);
				expect(session.thinkingLevel).toBe(Effort.High);
			});
		});
	});
});
