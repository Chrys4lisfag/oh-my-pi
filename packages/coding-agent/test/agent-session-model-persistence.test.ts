import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type Api, type AssistantMessage, Effort, type Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type CreateAgentSessionResult, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { getRestorableSessionModels } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { EPHEMERAL_MODEL_CHANGE_ROLE } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AUTO_THINKING } from "@oh-my-pi/pi-coding-agent/thinking";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession model persistence", () => {
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	let sessionSettings: Settings;
	// Auth storage (SQLite DB) and the model registry are immutable across these tests:
	// every test sets the same anthropic runtime key and only ever reads the bundled model
	// list. Building them once avoids ~12 SQLite opens + registry constructions.
	let sharedDir: TempDir;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-model-persistence-shared-");
		sharedAuthStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		sharedAuthStorage.setRuntimeApiKey("anthropic", "test-key");
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedDir.path(), "models.yml"));
	});

	afterAll(() => {
		sharedAuthStorage.close();
		sharedDir.removeSync();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-model-persistence-");
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		tempDir.removeSync();
	});

	function getAnthropicModelOrThrow(id: string): Model<Api> {
		const model = getBundledModel("anthropic", id);
		if (!model) throw new Error(`Expected anthropic model ${id} to exist`);
		return model;
	}

	function modelValue(model: Model<Api>): string {
		return `${model.provider}/${model.id}`;
	}

	async function writeRoleModelSession(
		defaultRoleValue: string,
		smolRoleValue: string,
		lastRole = "smol",
		profile?: { name: string; snapshot: { modelRoles: Record<string, string>; defaultThinkingLevel: string } },
	): Promise<string> {
		const targetSessionFile = path.join(tempDir.path(), `target-${Bun.nanoseconds()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			targetSessionFile,
			`${[
				{
					type: "session",
					version: 3,
					id: "target-session",
					timestamp,
					cwd: tempDir.path(),
					profile: profile?.name,
					profileSnapshot: profile?.snapshot,
				},
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					model: defaultRoleValue,
					role: "default",
				},
				{
					type: "model_change",
					id: "smol-model",
					parentId: "default-model",
					timestamp,
					model: smolRoleValue,
					role: lastRole,
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		return targetSessionFile;
	}
	async function createSession(options?: {
		initialModel?: Model<Api>;
		selectInitialModel?: (availableModels: Model<Api>[]) => Model<Api>;
		modelRoles?: Record<string, string>;
		persist?: boolean;
	}): Promise<{ modelRegistry: ModelRegistry; settings: Settings; session: AgentSession }> {
		const modelRegistry = sharedModelRegistry;
		const model =
			options?.initialModel ??
			options?.selectInitialModel?.(modelRegistry.getAvailable()) ??
			getAnthropicModelOrThrow("claude-sonnet-4-5");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
		});

		sessionSettings = Settings.isolated();
		const modelRoles = options?.modelRoles;
		if (modelRoles) {
			for (const role in modelRoles) {
				const modelRoleValue = modelRoles[role];
				if (modelRoleValue !== undefined) {
					sessionSettings.setModelRole(role, modelRoleValue);
				}
			}
		}
		session = new AgentSession({
			agent,
			sessionManager: options?.persist
				? SessionManager.create(tempDir.path(), path.join(tempDir.path(), "active"))
				: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});

		return { modelRegistry, settings: sessionSettings, session };
	}

	async function createStartupResumeSession(
		targetSessionFile: string,
		settings: Settings = Settings.isolated(),
	): Promise<CreateAgentSessionResult> {
		const sessionManager = await SessionManager.open(targetSessionFile, path.join(tempDir.path(), "startup"));
		const result = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage: sharedAuthStorage,
			modelRegistry: sharedModelRegistry,
			sessionManager,
			settings,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		session = result.session;
		return result;
	}
	it("switches the active model without persisting by default", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const nextModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);

		const created = await createSession({
			initialModel: defaultModel,
			modelRoles: { default: defaultRoleValue },
		});
		let modelChangedCount = 0;
		created.session.subscribe(event => {
			if (event.type === "model_changed") modelChangedCount++;
		});

		await created.session.setModel(nextModel);

		expect(created.session.model?.id).toBe(nextModel.id);
		expect(created.settings.getModelRole("default")).toBe(defaultRoleValue);
		expect(modelChangedCount).toBe(1);

		await created.session.setModel(nextModel);
		expect(modelChangedCount).toBe(1);
	});

	it("persists the default role when explicitly requested", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const nextModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		const created = await createSession({
			initialModel: defaultModel,
			modelRoles: { default: modelValue(defaultModel) },
		});
		const profileSnapshot = {
			modelRoles: { default: modelValue(defaultModel) },
			defaultThinkingLevel: "medium",
		};
		created.settings.set("profiles.items", { "gpt-edu": profileSnapshot });
		created.settings.set("profiles.active", "gpt-edu");
		await created.session.bindSessionProfile("gpt-edu");

		await created.session.setModel(nextModel, "default", { persist: true });

		expect(created.session.model?.id).toBe(nextModel.id);
		expect(created.settings.getModelRole("default")).toBe(modelValue(nextModel));
		expect(created.session.sessionManager.getSessionProfileSnapshot()?.modelRoles.default).toBe(
			modelValue(nextModel),
		);
	});

	it("persists cycleThinkingLevel changes into the bound profile snapshot and session header", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const profileSnapshot = {
			modelRoles: { default: modelValue(defaultModel) },
			defaultThinkingLevel: Effort.Medium,
		};
		const created = await createSession({
			initialModel: defaultModel,
			modelRoles: profileSnapshot.modelRoles,
			persist: true,
		});
		created.settings.set("profiles.items", { "gpt-edu": profileSnapshot });
		created.settings.set("profiles.active", "gpt-edu");
		expect(await created.session.bindSessionProfile("gpt-edu")).toBe(true);
		await created.session.waitForIdle();
		await created.session.sessionManager.ensureOnDisk();

		const nextThinkingLevel = created.session.cycleThinkingLevel(true);
		await created.session.waitForIdle();
		await created.session.sessionManager.flush();

		expect(nextThinkingLevel).toBe(Effort.High);
		expect(created.settings.get("defaultThinkingLevel")).toBe(Effort.High);
		expect(created.settings.profileSnapshot("gpt-edu")?.defaultThinkingLevel).toBe(Effort.High);
		expect(created.session.sessionManager.getSessionProfileSnapshot()?.defaultThinkingLevel).toBe(Effort.High);

		const sessionFile = created.session.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		const header = (await Bun.file(sessionFile).text())
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as Record<string, unknown>)
			.find(entry => entry.type === "session");
		if (!header) throw new Error("Expected persisted session header");
		expect(header).toMatchObject({
			profile: "gpt-edu",
			profileSnapshot: {
				modelRoles: profileSnapshot.modelRoles,
				defaultThinkingLevel: Effort.High,
			},
		});
	});

	it("switches the active model even when the live context is over the target window", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const nextModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		const created = await createSession({
			initialModel: defaultModel,
			modelRoles: { default: modelValue(defaultModel) },
		});

		const targetWindow = nextModel.contextWindow ?? 0;
		expect(targetWindow).toBeGreaterThan(0);

		const result = await created.session.setModel(nextModel, "default", { persist: true });

		expect(result).toEqual({ switched: true });
		expect(created.session.model?.id).toBe(nextModel.id);
		expect(created.settings.getModelRole("default")).toBe(modelValue(nextModel));
	});

	it("cycles role models without rewriting configured roles", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const slowModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const slowRoleValue = `${modelValue(slowModel)}:high`;

		const created = await createSession({
			initialModel: defaultModel,
			modelRoles: {
				default: defaultRoleValue,
				slow: slowRoleValue,
			},
		});

		const result = await created.session.cycleRoleModels(["default", "slow"]);

		expect(result?.role).toBe("slow");
		expect(result?.model.id).toBe(slowModel.id);
		expect(created.session.model?.id).toBe(slowModel.id);
		expect(created.settings.getModelRole("default")).toBe(defaultRoleValue);
		expect(created.settings.getModelRole("slow")).toBe(slowRoleValue);
	});

	it("cycles role models backward from the current role", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const slowModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const slowRoleValue = modelValue(slowModel);

		const created = await createSession({
			initialModel: defaultModel,
			modelRoles: {
				default: defaultRoleValue,
				slow: slowRoleValue,
			},
		});

		const forward = await created.session.cycleRoleModels(["default", "slow"], "forward");
		const backward = await created.session.cycleRoleModels(["default", "slow"], "backward");

		expect(forward?.role).toBe("slow");
		expect(backward?.role).toBe("default");
		expect(created.session.model?.id).toBe(defaultModel.id);
		expect(created.settings.getModelRole("default")).toBe(defaultRoleValue);
		expect(created.settings.getModelRole("slow")).toBe(slowRoleValue);
	});

	it("cycles available models without persisting the default role", async () => {
		const created = await createSession({
			selectInitialModel: availableModels => {
				if (availableModels.length <= 1 || !availableModels[0]) {
					throw new Error("Expected at least two available models");
				}
				return availableModels[0];
			},
		});
		const initialModel = created.session.model;
		if (!initialModel) throw new Error("Expected initial model to be set");
		const defaultRoleValue = modelValue(initialModel);
		created.settings.setModelRole("default", defaultRoleValue);

		const result = await created.session.cycleModel();

		if (!result) throw new Error("Expected cycleModel to return a new model");
		expect(modelValue(result.model)).not.toBe(defaultRoleValue);
		const activeModel = created.session.model;
		if (!activeModel) throw new Error("Expected active model after cycleModel");
		expect(modelValue(activeModel)).toBe(modelValue(result.model));
		expect(created.settings.getModelRole("default")).toBe(defaultRoleValue);
	});

	it("restores the last active role model when switching sessions", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const smolModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const smolRoleValue = modelValue(smolModel);

		const targetSessionFile = await writeRoleModelSession(defaultRoleValue, smolRoleValue);

		const created = await createSession({
			initialModel: defaultModel,
			modelRoles: { default: defaultRoleValue, smol: smolRoleValue },
			persist: true,
		});

		await expect(created.session.switchSession(targetSessionFile)).resolves.toBe(true);
		expect(created.session.model?.id).toBe(smolModel.id);
	});
	it("binds an empty persisted session from its header profile", async () => {
		const eduModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const cyberModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const eduSnapshot = {
			modelRoles: { default: modelValue(eduModel) },
			defaultThinkingLevel: "medium",
		};
		const cyberSnapshot = {
			modelRoles: { default: modelValue(cyberModel) },
			defaultThinkingLevel: "high",
		};
		const targetSessionFile = path.join(tempDir.path(), `empty-profile-${Bun.nanoseconds()}.jsonl`);
		await Bun.write(
			targetSessionFile,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "empty-profile-session",
				timestamp: "2026-06-01T00:00:00.000Z",
				cwd: tempDir.path(),
				profile: "gpt-edu",
				profileSnapshot: eduSnapshot,
			})}\n`,
		);
		const settings = Settings.isolated();
		settings.set("profiles.items", { "gpt-edu": eduSnapshot, "gpt-cyber": cyberSnapshot });
		settings.set("profiles.active", "gpt-cyber");
		settings.set("modelRoles", cyberSnapshot.modelRoles);

		const result = await createStartupResumeSession(targetSessionFile, settings);

		expect(settings.activeProfileName()).toBe("gpt-edu");
		expect(result.session.getSessionProfileName()).toBe("gpt-edu");
		expect(result.session.model?.id).toBe(eduModel.id);
	});

	it("keeps an empty persisted legacy session unbound instead of stamping disk active", async () => {
		const cyberModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const cyberSnapshot = {
			modelRoles: { default: modelValue(cyberModel) },
			defaultThinkingLevel: "high",
		};
		const targetSessionFile = path.join(tempDir.path(), `empty-legacy-${Bun.nanoseconds()}.jsonl`);
		await Bun.write(
			targetSessionFile,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "empty-legacy-session",
				timestamp: "2026-06-01T00:00:00.000Z",
				cwd: tempDir.path(),
			})}\n`,
		);
		const settings = Settings.isolated();
		settings.set("profiles.items", { "gpt-cyber": cyberSnapshot });
		settings.set("profiles.active", "gpt-cyber");
		settings.set("modelRoles", cyberSnapshot.modelRoles);

		const result = await createStartupResumeSession(targetSessionFile, settings);

		expect(settings.activeProfileName()).toBeUndefined();
		expect(result.session.getSessionProfileName()).toBeUndefined();
		expect(result.session.sessionManager.getSessionProfile()).toBeUndefined();
	});

	it("restores the last active role model during startup resume", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const smolModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const smolRoleValue = modelValue(smolModel);
		const targetSessionFile = await writeRoleModelSession(defaultRoleValue, smolRoleValue);

		const result = await createStartupResumeSession(targetSessionFile);

		expect(result.session.model?.id).toBe(smolModel.id);
	});

	it("restores each session's profile, model, thinking, settings, and header snapshot when switching both ways", async () => {
		const eduModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const cyberModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const eduSnapshot = {
			modelRoles: { default: modelValue(eduModel) },
			defaultThinkingLevel: Effort.Medium,
		};
		const cyberSnapshot = {
			modelRoles: { default: modelValue(cyberModel) },
			defaultThinkingLevel: Effort.High,
		};
		const targetSessionFile = await writeRoleModelSession(modelValue(eduModel), modelValue(eduModel), "default", {
			name: "gpt-edu",
			snapshot: eduSnapshot,
		});
		const created = await createSession({ initialModel: cyberModel, persist: true });
		created.settings.set("profiles.items", { "gpt-edu": eduSnapshot, "gpt-cyber": cyberSnapshot });
		created.settings.set("profiles.active", "gpt-cyber");
		created.settings.set("modelRoles", cyberSnapshot.modelRoles);
		expect(await created.session.bindSessionProfile("gpt-cyber")).toBe(true);
		await created.session.waitForIdle();
		created.session.sessionManager.appendModelChange(modelValue(cyberModel), "default");
		await created.session.sessionManager.ensureOnDisk();
		const sourceSessionFile = created.session.sessionManager.getSessionFile();
		if (!sourceSessionFile) throw new Error("Expected source session file");

		await expect(created.session.switchSession(targetSessionFile)).resolves.toBe(true);
		await created.session.waitForIdle();

		expect(created.settings.activeProfileName()).toBe("gpt-edu");
		expect(created.settings.currentProfileSnapshot()).toEqual(eduSnapshot);
		expect(created.settings.getModelRole("default")).toBe(modelValue(eduModel));
		expect(created.settings.get("defaultThinkingLevel")).toBe(Effort.Medium);
		expect(created.session.getSessionProfileName()).toBe("gpt-edu");
		expect(created.session.model?.id).toBe(eduModel.id);
		expect(created.session.configuredThinkingLevel()).toBe(Effort.Medium);
		expect(created.session.sessionManager.getHeader()).toMatchObject({
			profile: "gpt-edu",
			profileSnapshot: eduSnapshot,
		});

		await expect(created.session.switchSession(sourceSessionFile)).resolves.toBe(true);
		await created.session.waitForIdle();

		expect(created.settings.activeProfileName()).toBe("gpt-cyber");
		expect(created.settings.currentProfileSnapshot()).toEqual(cyberSnapshot);
		expect(created.settings.getModelRole("default")).toBe(modelValue(cyberModel));
		expect(created.settings.get("defaultThinkingLevel")).toBe(Effort.High);
		expect(created.session.getSessionProfileName()).toBe("gpt-cyber");
		expect(created.session.model?.id).toBe(cyberModel.id);
		expect(created.session.configuredThinkingLevel()).toBe(Effort.High);
		expect(created.session.sessionManager.getHeader()).toMatchObject({
			profile: "gpt-cyber",
			profileSnapshot: cyberSnapshot,
		});
	});

	it("rolls back profile binding ownership, runtime, settings, and header when target model apply fails", async () => {
		const sourceModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const targetModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const sourceSnapshot = {
			modelRoles: { default: modelValue(sourceModel) },
			defaultThinkingLevel: Effort.Medium,
		};
		const targetSnapshot = {
			modelRoles: { default: modelValue(targetModel) },
			defaultThinkingLevel: Effort.High,
		};
		const created = await createSession({ initialModel: sourceModel, persist: true });
		created.settings.set("profiles.items", {
			"source-profile": sourceSnapshot,
			"target-profile": targetSnapshot,
		});
		created.settings.set("profiles.active", "source-profile");
		expect(await created.session.bindSessionProfile("source-profile")).toBe(true);
		await created.session.waitForIdle();
		await created.session.sessionManager.ensureOnDisk();

		const failure = new Error("injected target model apply failure");
		const setModel = created.session.setModel.bind(created.session);
		const setModelSpy = vi.spyOn(created.session, "setModel").mockImplementation(async (model, role, options) => {
			if (model.id === targetModel.id) {
				created.session.agent.setModel(model);
				throw failure;
			}
			return setModel(model, role, options);
		});

		try {
			await expect(created.session.bindSessionProfile("target-profile")).rejects.toThrow(failure);
			await created.session.waitForIdle();
		} finally {
			setModelSpy.mockRestore();
		}

		expect(created.settings.activeProfileName()).toBe("source-profile");
		expect(created.settings.currentProfileSnapshot()).toEqual(sourceSnapshot);
		expect(created.settings.getModelRole("default")).toBe(modelValue(sourceModel));
		expect(created.settings.get("defaultThinkingLevel")).toBe(Effort.Medium);
		expect(created.session.getSessionProfileName()).toBe("source-profile");
		expect(created.session.model?.id).toBe(sourceModel.id);
		expect(created.session.configuredThinkingLevel()).toBe(Effort.Medium);
		expect(created.session.sessionManager.getHeader()).toMatchObject({
			profile: "source-profile",
			profileSnapshot: sourceSnapshot,
		});
	});

	it("rolls back profile, model, thinking, settings, and header when a session switch fails after target apply", async () => {
		const sourceModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const targetModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const sourceSnapshot = {
			modelRoles: { default: modelValue(sourceModel) },
			defaultThinkingLevel: Effort.High,
		};
		const targetSnapshot = {
			modelRoles: { default: modelValue(targetModel) },
			defaultThinkingLevel: Effort.Medium,
		};
		const targetSessionFile = await writeRoleModelSession(
			modelValue(targetModel),
			modelValue(targetModel),
			"default",
			{ name: "target-profile", snapshot: targetSnapshot },
		);
		const created = await createSession({ initialModel: sourceModel, persist: true });
		created.settings.set("profiles.items", {
			"source-profile": sourceSnapshot,
			"target-profile": targetSnapshot,
		});
		created.settings.set("profiles.active", "source-profile");
		created.settings.set("modelRoles", sourceSnapshot.modelRoles);
		expect(await created.session.bindSessionProfile("source-profile")).toBe(true);
		await created.session.waitForIdle();
		created.session.sessionManager.appendModelChange(modelValue(sourceModel), "default");
		await created.session.sessionManager.ensureOnDisk();
		const sourceSessionFile = created.session.sessionManager.getSessionFile();
		if (!sourceSessionFile) throw new Error("Expected source session file");

		const failure = new Error("injected switch failure after target runtime apply");
		const getSessionId = created.session.sessionManager.getSessionId.bind(created.session.sessionManager);
		let injected = false;
		const getSessionIdSpy = vi.spyOn(created.session.sessionManager, "getSessionId").mockImplementation(() => {
			const activeFile = created.session.sessionManager.getSessionFile();
			if (
				!injected &&
				activeFile &&
				path.resolve(activeFile) === path.resolve(targetSessionFile) &&
				created.session.model?.id === targetModel.id &&
				created.session.configuredThinkingLevel() === Effort.Medium
			) {
				injected = true;
				throw failure;
			}
			return getSessionId();
		});

		try {
			await expect(created.session.switchSession(targetSessionFile)).rejects.toThrow(failure);
		} finally {
			getSessionIdSpy.mockRestore();
		}

		expect(injected).toBe(true);
		expect(created.session.sessionManager.getSessionFile()).toBe(sourceSessionFile);
		expect(created.settings.activeProfileName()).toBe("source-profile");
		expect(created.settings.currentProfileSnapshot()).toEqual(sourceSnapshot);
		expect(created.settings.getModelRole("default")).toBe(modelValue(sourceModel));
		expect(created.settings.get("defaultThinkingLevel")).toBe(Effort.High);
		expect(created.session.getSessionProfileName()).toBe("source-profile");
		expect(created.session.model?.id).toBe(sourceModel.id);
		expect(created.session.configuredThinkingLevel()).toBe(Effort.High);
		expect(created.session.sessionManager.getHeader()).toMatchObject({
			profile: "source-profile",
			profileSnapshot: sourceSnapshot,
		});
	});

	it("restores the session profile instead of the disk startup profile", async () => {
		const eduModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const cyberModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const eduSnapshot = {
			modelRoles: { default: modelValue(eduModel), smol: modelValue(eduModel) },
			defaultThinkingLevel: "medium",
		};
		const cyberSnapshot = {
			modelRoles: { default: modelValue(cyberModel) },
			defaultThinkingLevel: "high",
		};
		const targetSessionFile = await writeRoleModelSession(modelValue(eduModel), modelValue(eduModel), "smol", {
			name: "gpt-edu",
			snapshot: eduSnapshot,
		});
		const settings = Settings.isolated();
		settings.set("profiles.items", { "gpt-edu": eduSnapshot, "gpt-cyber": cyberSnapshot });
		settings.set("profiles.active", "gpt-cyber");
		settings.set("modelRoles", cyberSnapshot.modelRoles);

		const result = await createStartupResumeSession(targetSessionFile, settings);

		expect(settings.activeProfileName()).toBe("gpt-edu");
		expect(settings.getModelRole("default")).toBe(modelValue(eduModel));
		expect(result.session.getSessionProfileName()).toBe("gpt-edu");
	});

	it("restores a missing session profile from the header snapshot", async () => {
		const eduModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const eduSnapshot = {
			modelRoles: { default: modelValue(eduModel) },
			defaultThinkingLevel: "medium",
		};
		const targetSessionFile = await writeRoleModelSession(modelValue(eduModel), modelValue(eduModel), "default", {
			name: "deleted-profile",
			snapshot: eduSnapshot,
		});
		const settings = Settings.isolated();
		settings.set("profiles.items", {});
		settings.set("profiles.active", "other");

		await createStartupResumeSession(targetSessionFile, settings);

		expect(settings.activeProfileName()).toBe("deleted-profile");
		expect(settings.profileSnapshot("deleted-profile")).toEqual(eduSnapshot);
	});

	it("restores a malformed session profile from the header snapshot", async () => {
		const eduModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const eduSnapshot = {
			modelRoles: { default: modelValue(eduModel) },
			defaultThinkingLevel: "high",
		};
		const targetSessionFile = await writeRoleModelSession(modelValue(eduModel), modelValue(eduModel), "default", {
			name: "broken-profile",
			snapshot: eduSnapshot,
		});
		const settings = Settings.isolated();
		settings.set("profiles.items", {
			"broken-profile": { modelRoles: { default: 7 }, defaultThinkingLevel: "low" },
		});
		settings.set("profiles.active", "other");

		await createStartupResumeSession(targetSessionFile, settings);

		expect(settings.activeProfileName()).toBe("broken-profile");
		expect(settings.profileSnapshot("broken-profile")).toEqual(eduSnapshot);
	});

	it("falls back to the saved default model when switch-session role restore is unavailable", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const previousModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const targetSessionFile = await writeRoleModelSession(defaultRoleValue, "anthropic/not-loaded-anymore");

		const created = await createSession({
			initialModel: previousModel,
			modelRoles: { default: defaultRoleValue },
			persist: true,
		});

		await expect(created.session.switchSession(targetSessionFile)).resolves.toBe(true);
		expect(created.session.model?.id).toBe(defaultModel.id);
	});

	it("restores the saved default model when switch-session last role is fallback", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const fallbackModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const targetSessionFile = await writeRoleModelSession(
			defaultRoleValue,
			modelValue(fallbackModel),
			EPHEMERAL_MODEL_CHANGE_ROLE,
		);

		const created = await createSession({
			initialModel: fallbackModel,
			modelRoles: { default: defaultRoleValue },
			persist: true,
		});

		await expect(created.session.switchSession(targetSessionFile)).resolves.toBe(true);
		expect(created.session.model?.id).toBe(defaultModel.id);
	});

	it("falls back to the saved default model when startup role restore is unavailable", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const settingsFallbackModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const targetSessionFile = await writeRoleModelSession(defaultRoleValue, "anthropic/not-loaded-anymore");
		const settings = Settings.isolated();
		settings.setModelRole("default", modelValue(settingsFallbackModel));

		const result = await createStartupResumeSession(targetSessionFile, settings);

		expect(result.session.model?.id).toBe(defaultModel.id);
	});

	it("restores the saved default model when startup last role is fallback", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const fallbackModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const targetSessionFile = await writeRoleModelSession(
			defaultRoleValue,
			modelValue(fallbackModel),
			EPHEMERAL_MODEL_CHANGE_ROLE,
		);
		const settings = Settings.isolated();
		settings.setModelRole("default", modelValue(fallbackModel));

		const result = await createStartupResumeSession(targetSessionFile, settings);

		expect(result.session.model?.id).toBe(defaultModel.id);
	});

	it("restores a temporary model when switching sessions", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const temporaryModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const targetSessionFile = await writeRoleModelSession(defaultRoleValue, modelValue(temporaryModel), "temporary");

		const created = await createSession({
			initialModel: defaultModel,
			modelRoles: { default: defaultRoleValue },
			persist: true,
		});

		await expect(created.session.switchSession(targetSessionFile)).resolves.toBe(true);
		expect(created.session.model?.id).toBe(temporaryModel.id);
	});

	it("restores a temporary model during startup resume", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const temporaryModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const targetSessionFile = await writeRoleModelSession(defaultRoleValue, modelValue(temporaryModel), "temporary");
		const settings = Settings.isolated();
		settings.setModelRole("default", defaultRoleValue);

		const result = await createStartupResumeSession(targetSessionFile, settings);

		expect(result.session.model?.id).toBe(temporaryModel.id);
	});

	it("activates auto thinking on startup resume when modelRoles.default carries an explicit :auto suffix", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const targetSessionFile = await writeRoleModelSession(
			modelValue(defaultModel),
			modelValue(defaultModel),
			"default",
		);
		const settings = Settings.isolated();
		settings.setModelRole("default", `${modelValue(defaultModel)}:auto`);

		const result = await createStartupResumeSession(targetSessionFile, settings);

		expect(result.session.model?.id).toBe(defaultModel.id);
		expect(result.session.configuredThinkingLevel()).toBe(AUTO_THINKING);
	});

	it("marks an incomplete process-exit transcript aborted during SDK resume without dropping history", async () => {
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "interrupted"));
		const interruptedAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: "state.txt" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
		sessionManager.appendMessage({ role: "user", content: "inspect state", timestamp: Date.now() });
		sessionManager.appendMessage(interruptedAssistant);
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call_read",
			toolName: "read",
			content: [{ type: "text", text: "preserved partial result" }],
			isError: false,
			timestamp: Date.now(),
		});
		sessionManager.appendCustomEntry("session_exit", {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});
		await sessionManager.flush();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected interrupted session file");

		const result = await createStartupResumeSession(sessionFile);
		const messages = result.session.sessionManager.buildSessionContext({ transcript: true }).messages;
		expect(messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [],
			stopReason: "aborted",
			errorMessage: "Previous OMP process exited before completing the turn.",
		});
		expect(
			messages.some(
				message =>
					message.role === "toolResult" &&
					message.content.some(part => part.type === "text" && part.text === "preserved partial result"),
			),
		).toBe(true);
		expect(messages.filter(message => message.role === "assistant" && message.stopReason === "aborted")).toHaveLength(
			1,
		);
	});

	it("marks a first user-message process-exit tail aborted with the selected model", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const settings = Settings.isolated();
		settings.setModelRole("default", modelValue(defaultModel));
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "interrupted-user"));
		sessionManager.appendModelChange(modelValue(defaultModel));
		sessionManager.appendMessage({ role: "user", content: "inspect state", timestamp: Date.now() });
		sessionManager.appendCustomEntry("session_exit", {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});
		const result = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage: sharedAuthStorage,
			modelRegistry: sharedModelRegistry,
			sessionManager,
			settings,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		session = result.session;
		expect(result.session.model?.id).toBe(defaultModel.id);
		expect(
			result.session.sessionManager
				.getBranch()
				.find(entry => entry.type === "message" && entry.message.role === "assistant"),
		).toMatchObject({
			type: "message",
			message: {
				role: "assistant",
				api: defaultModel.api,
				provider: defaultModel.provider,
				model: defaultModel.id,
				stopReason: "aborted",
			},
		});
	});

	it("marks an interrupted first turn aborted when switching sessions", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const created = await createSession({ initialModel: defaultModel, persist: true });
		const targetFile = path.join(tempDir.path(), "switch-interrupted-user.jsonl");
		const timestamp = "2026-07-11T02:20:08.800Z";
		await Bun.write(
			targetFile,
			`${[
				{ type: "session", version: 3, id: "switch-target", timestamp, cwd: tempDir.path() },
				{
					type: "model_change",
					id: "model",
					parentId: null,
					timestamp,
					model: modelValue(defaultModel),
				},
				{
					type: "message",
					id: "user",
					parentId: "model",
					timestamp,
					message: { role: "user", content: "inspect state", timestamp: Date.parse(timestamp) },
				},
				{
					type: "custom",
					id: "exit",
					parentId: "user",
					timestamp,
					customType: "session_exit",
					data: { reason: "exit", kind: "process_exit", recordedAt: timestamp },
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);

		await expect(created.session.switchSession(targetFile)).resolves.toBe(true);

		expect(created.session.sessionManager.buildSessionContext({ transcript: true }).messages.at(-1)).toMatchObject({
			role: "assistant",
			api: defaultModel.api,
			provider: defaultModel.provider,
			model: defaultModel.id,
			stopReason: "aborted",
		});
	});

	it("lists restorable temporary model before the default fallback", () => {
		expect(
			getRestorableSessionModels(
				{
					default: "anthropic/claude-sonnet-4-5",
					temporary: "anthropic/claude-sonnet-4-6",
				},
				"temporary",
			),
		).toEqual(["anthropic/claude-sonnet-4-6", "anthropic/claude-sonnet-4-5"]);
	});

	it("lists only the default model for ephemeral fallback restores", () => {
		expect(
			getRestorableSessionModels(
				{
					default: "anthropic/claude-sonnet-4-5",
					[EPHEMERAL_MODEL_CHANGE_ROLE]: "anthropic/claude-sonnet-4-6",
				},
				EPHEMERAL_MODEL_CHANGE_ROLE,
			),
		).toEqual(["anthropic/claude-sonnet-4-5"]);
	});

	it("lists a named role model before the default fallback", () => {
		expect(
			getRestorableSessionModels(
				{
					default: "anthropic/claude-sonnet-4-5",
					smol: "anthropic/claude-sonnet-4-6",
				},
				"smol",
			),
		).toEqual(["anthropic/claude-sonnet-4-6", "anthropic/claude-sonnet-4-5"]);
	});
});
