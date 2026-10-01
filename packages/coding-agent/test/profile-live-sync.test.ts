import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { cfgModelRoles } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgProfilesActive, cfgProfilesItems } from "@oh-my-pi/pi-coding-agent/config/profiles";
import { cfgDefaultThinkingLevel, cfgExternalThinking } from "@oh-my-pi/pi-coding-agent/session/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

const PROVIDER = "anthropic";
const INITIAL_MODEL_ID = "claude-sonnet-4-5";
const FALLBACK_MODEL_ID = "claude-haiku-4-5";
type TestProfileSnapshot = { modelRoles: Record<string, string>; defaultThinkingLevel: string };
function profileSnapshot(settings: Settings, name: string): TestProfileSnapshot | undefined {
	return cfgProfilesItems.get(settings)[name] as TestProfileSnapshot | undefined;
}

describe("live profile synchronization", () => {
	let tempDir: TempDir;
	let writer: Settings;
	let peer: Settings;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;
	let requestedModels: string[];
	let onProviderCall: (() => void) | undefined;

	async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!predicate()) {
			if (Date.now() >= deadline) throw new Error("Timed out waiting for live profile synchronization");
			await Bun.sleep(25);
		}
	}

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-profile-live-sync-");
		writer = await Settings.loadIsolated({ cwd: tempDir.path(), agentDir: tempDir.path() });
		writer.setProfileItem("selected", {
			modelRoles: { default: `${PROVIDER}/${INITIAL_MODEL_ID}` },
			defaultThinkingLevel: Effort.Medium,
		});
		writer.setProfileItem("fallback", {
			modelRoles: { default: `${PROVIDER}/${FALLBACK_MODEL_ID}` },
			defaultThinkingLevel: Effort.High,
		});
		writer.setProfileItem("inactive", {
			modelRoles: { default: `${PROVIDER}/${FALLBACK_MODEL_ID}` },
			defaultThinkingLevel: Effort.Low,
		});
		writer.activateProfile("selected", {
			modelRoles: { default: `${PROVIDER}/${INITIAL_MODEL_ID}` },
			defaultThinkingLevel: Effort.Medium,
		});
		await writer.flush();

		peer = await writer.cloneForCwd(tempDir.path());
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime(PROVIDER, "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const initialModel = getBundledModel(PROVIDER, INITIAL_MODEL_ID);
		if (!initialModel) throw new Error(`Expected bundled model ${PROVIDER}/${INITIAL_MODEL_ID}`);
		requestedModels = [];
		const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		const agent = new Agent({
			initialState: {
				model: initialModel,
				thinkingLevel: Effort.Medium,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestedModels.push(model.id);
				onProviderCall?.();
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: peer,
			modelRegistry,
		});
	});

	afterEach(async () => {
		vi.useRealTimers();
		if (session) await session.dispose();
		resetSettingsForTest();
		AgentStorage.close();
		if (authStorage) authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
	});

	async function startOnFallback(): Promise<void> {
		await session.dispose();
		peer = await writer.cloneForCwd(tempDir.path());
		const model = getBundledModel(PROVIDER, FALLBACK_MODEL_ID);
		if (!model) throw new Error("Expected bundled fallback model");
		const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, thinkingLevel: Effort.Medium, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: (activeModel, context, options) => {
					requestedModels.push(activeModel.id);
					return mock.stream(activeModel, context, options);
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: peer,
			modelRegistry,
			initialRetryFallback: {
				role: "default",
				originalSelector: `${PROVIDER}/${INITIAL_MODEL_ID}`,
				originalThinkingLevel: Effort.Medium,
			},
		});
	}

	it("preserves a healthy fallback across unrelated same-profile synchronization", async () => {
		await startOnFallback();
		writer.setProfileItem("inactive", {
			modelRoles: { default: `${PROVIDER}/${INITIAL_MODEL_ID}` },
			defaultThinkingLevel: Effort.Low,
		});
		await writer.flush();
		await peer.syncFromDisk();
		await session.waitForIdle();
		expect(session.model?.id).toBe(FALLBACK_MODEL_ID);
		expect(session.servingModel?.isFallback).toBe(true);
	});

	it("clears fallback ownership when the bound profile changes its default to that same model", async () => {
		await startOnFallback();
		writer.setProfileItem("selected", {
			modelRoles: { default: `${PROVIDER}/${FALLBACK_MODEL_ID}` },
			defaultThinkingLevel: Effort.High,
		});
		await writer.flush();
		await peer.syncFromDisk();
		await session.waitForIdle();
		expect(session.model?.id).toBe(FALLBACK_MODEL_ID);
		expect(session.servingModel?.isFallback).toBe(false);
		await session.prompt("use the edited profile");
		expect(requestedModels).toEqual([FALLBACK_MODEL_ID]);
	});

	it("makes the current fallback the new profile's primary even when the model identity is unchanged", async () => {
		await startOnFallback();
		modelRegistry.suppressSelector(`${PROVIDER}/${FALLBACK_MODEL_ID}`, Date.now() + 60_000);
		expect(session.servingModel?.isFallback).toBe(true);

		expect(await session.bindSessionProfile("fallback")).toBe(true);
		expect(session.model?.id).toBe(FALLBACK_MODEL_ID);
		expect(modelRegistry.isSelectorSuppressed(`${PROVIDER}/${FALLBACK_MODEL_ID}`)).toBe(false);
		expect(session.servingModel?.isFallback).toBe(false);
		await session.prompt("use the new primary");
		expect(requestedModels).toEqual([FALLBACK_MODEL_ID]);
		expect(session.servingModel?.isFallback).toBe(false);
	});

	it("reselects the configured primary when explicitly rebinding the same profile", async () => {
		await startOnFallback();
		expect(await session.bindSessionProfile("selected")).toBe(true);
		expect(session.model?.id).toBe(INITIAL_MODEL_ID);
		await session.prompt("use the configured primary");
		expect(requestedModels).toEqual([INITIAL_MODEL_ID]);
		expect(session.servingModel?.isFallback).toBe(false);
	});

	it("restores fallback ownership when a profile apply fails", async () => {
		await startOnFallback();
		const apply = vi.spyOn(session, "setModel").mockRejectedValueOnce(new Error("profile apply failed"));
		try {
			await expect(session.bindSessionProfile("fallback")).rejects.toThrow("profile apply failed");
			await session.waitForIdle();
			expect(session.getSessionProfileName()).toBe("selected");
			expect(session.model?.id).toBe(FALLBACK_MODEL_ID);
			expect(session.servingModel?.isFallback).toBe(true);
			await session.prompt("continue the previous fallback");
			expect(requestedModels).toEqual([FALLBACK_MODEL_ID]);
			expect(session.servingModel?.isFallback).toBe(true);
		} finally {
			apply.mockRestore();
		}
	});

	it("does not let a pending old-primary restore override an explicit profile bind", async () => {
		await startOnFallback();
		await session.prompt("establish successful fallback");
		const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 13 * 60_000);
		const lookupStarted = Promise.withResolvers<void>();
		const releaseLookup = Promise.withResolvers<void>();
		const getApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		const lookup = vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, sessionId) => {
			if (model.id === INITIAL_MODEL_ID) {
				lookupStarted.resolve();
				await releaseLookup.promise;
			}
			return getApiKey(model, sessionId);
		});
		const prompting = session.prompt("continue after cooldown");
		try {
			await lookupStarted.promise;
			expect(await session.bindSessionProfile("fallback")).toBe(true);
			releaseLookup.resolve();
			await prompting;
			expect(session.model?.id).toBe(FALLBACK_MODEL_ID);
			expect(requestedModels).toEqual([FALLBACK_MODEL_ID]);
			await session.prompt("dispatch after the profile transition");
			expect(requestedModels).toEqual([FALLBACK_MODEL_ID, FALLBACK_MODEL_ID]);
			expect(session.servingModel?.isFallback).toBe(false);
		} finally {
			releaseLookup.resolve();
			lookup.mockRestore();
			now.mockRestore();
		}
	});

	it("isolates a switch and subsequent edit to a different active profile", async () => {
		writer.activateProfile("fallback", {
			modelRoles: { default: `${PROVIDER}/${FALLBACK_MODEL_ID}` },
			defaultThinkingLevel: Effort.High,
		});
		cfgDefaultThinkingLevel.set(writer, Effort.Low);
		await writer.flush();

		await waitFor(() => profileSnapshot(peer, "fallback")?.defaultThinkingLevel === Effort.Low);

		expect(cfgProfilesActive.get(peer)).toBe("selected");
		expect(peer.getModelRole("default")).toBe(`${PROVIDER}/${INITIAL_MODEL_ID}`);
		expect(session.model?.id).toBe(INITIAL_MODEL_ID);
		expect(cfgDefaultThinkingLevel.get(peer)).toBe(Effort.Medium);
		expect(profileSnapshot(writer, "fallback")?.defaultThinkingLevel).toBe(Effort.Low);
	});

	it("applies the save-time freshest activation snapshot to the activating session", async () => {
		writer.setProfileItem("fallback", {
			modelRoles: { default: `${PROVIDER}/${FALLBACK_MODEL_ID}` },
			defaultThinkingLevel: Effort.Low,
		});
		await writer.flush();

		peer.activateProfile("fallback", {
			modelRoles: { default: `${PROVIDER}/${INITIAL_MODEL_ID}` },
			defaultThinkingLevel: Effort.High,
		});
		await peer.flush();
		await waitFor(
			() =>
				cfgProfilesActive.get(peer) === "fallback" &&
				peer.getModelRole("default") === `${PROVIDER}/${FALLBACK_MODEL_ID}` &&
				cfgDefaultThinkingLevel.get(peer) === Effort.Low &&
				session.model?.id === FALLBACK_MODEL_ID &&
				session.thinkingLevel === Effort.Low,
		);
	});

	it("runs one live apply for an explicit profile bind", async () => {
		const apply = vi.spyOn(session, "applyProfileToSession");
		peer.activateProfile("fallback", {
			modelRoles: { default: `${PROVIDER}/${FALLBACK_MODEL_ID}` },
			defaultThinkingLevel: Effort.High,
		});

		expect(await session.bindSessionProfile("fallback")).toBe(true);
		await session.waitForIdle();

		expect(apply).toHaveBeenCalledTimes(1);
		expect(session.model?.id).toBe(FALLBACK_MODEL_ID);
		expect(session.thinkingLevel).toBe(Effort.High);
	});

	it("blocks prompt dispatch until an explicit profile bind finishes", async () => {
		const applyStarted = Promise.withResolvers<void>();
		const releaseApply = Promise.withResolvers<void>();
		const setModel = session.setModel.bind(session);
		vi.spyOn(session, "setModel").mockImplementation(async (model, role, options) => {
			applyStarted.resolve();
			await releaseApply.promise;
			return setModel(model, role, options);
		});

		peer.activateProfile("fallback", {
			modelRoles: { default: `${PROVIDER}/${FALLBACK_MODEL_ID}` },
			defaultThinkingLevel: Effort.High,
		});
		const binding = session.bindSessionProfile("fallback");
		await applyStarted.promise;
		const prompting = session.prompt("after explicit profile bind");

		expect(await Promise.race([prompting.then(() => true), Bun.sleep(100).then(() => false)])).toBe(false);
		expect(requestedModels).toEqual([]);

		releaseApply.resolve();
		expect(await binding).toBe(true);
		await prompting;
		expect(requestedModels).toEqual([FALLBACK_MODEL_ID]);
	});

	it("does not let an older failed bind roll back a newer profile", async () => {
		const firstStarted = Promise.withResolvers<void>();
		const firstApply = Promise.withResolvers<void>();
		let applyCount = 0;
		vi.spyOn(session, "applyProfileToSession").mockImplementation(async () => {
			applyCount++;
			if (applyCount !== 1) return;
			firstStarted.resolve();
			await firstApply.promise;
		});

		peer.activateProfile("fallback", {
			modelRoles: { default: `${PROVIDER}/${FALLBACK_MODEL_ID}` },
			defaultThinkingLevel: Effort.High,
		});
		const olderBind = session.bindSessionProfile("fallback");
		await firstStarted.promise;

		peer.activateProfile("inactive", {
			modelRoles: { default: `${PROVIDER}/${FALLBACK_MODEL_ID}` },
			defaultThinkingLevel: Effort.Low,
		});
		const newerBind = session.bindSessionProfile("inactive");

		firstApply.reject(new Error("injected older bind failure"));
		await expect(olderBind).rejects.toThrow("injected older bind failure");
		expect(await newerBind).toBe(true);
		await session.waitForIdle();

		expect(peer.activeProfileName()).toBe("inactive");
		expect(session.getSessionProfileName()).toBe("inactive");
		expect(session.sessionManager.getSessionProfile()).toBe("inactive");
		expect(session.sessionManager.getSessionProfileSnapshot()?.defaultThinkingLevel).toBe(Effort.Low);
	});

	it("propagates a live model edit to both sessions using the same profile", async () => {
		const initialModel = getBundledModel(PROVIDER, INITIAL_MODEL_ID);
		const fallbackModel = getBundledModel(PROVIDER, FALLBACK_MODEL_ID);
		if (!initialModel || !fallbackModel) throw new Error("Expected bundled profile test models");
		const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		const writerSession = new AgentSession({
			agent: new Agent({
				initialState: {
					model: initialModel,
					thinkingLevel: Effort.Medium,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				streamFn: mock.stream,
			}),
			sessionManager: SessionManager.inMemory(),
			settings: writer,
			modelRegistry,
		});

		try {
			await writerSession.setModel(fallbackModel, "default", { persist: true });
			await writer.flush();
			await waitFor(
				() =>
					peer.getModelRole("default") === `${PROVIDER}/${FALLBACK_MODEL_ID}` &&
					writerSession.model?.id === FALLBACK_MODEL_ID &&
					session.model?.id === FALLBACK_MODEL_ID,
			);

			expect(cfgProfilesActive.get(peer)).toBe("selected");
			expect(profileSnapshot(writer, "selected")?.modelRoles.default).toBe(`${PROVIDER}/${FALLBACK_MODEL_ID}`);
			expect(profileSnapshot(peer, "selected")?.modelRoles.default).toBe(`${PROVIDER}/${FALLBACK_MODEL_ID}`);
			expect(writerSession.sessionManager.getSessionProfileSnapshot()?.modelRoles.default).toBe(
				`${PROVIDER}/${FALLBACK_MODEL_ID}`,
			);
			expect(session.sessionManager.getSessionProfileSnapshot()?.modelRoles.default).toBe(
				`${PROVIDER}/${FALLBACK_MODEL_ID}`,
			);
		} finally {
			await writerSession.dispose();
		}
	});

	it("propagates thinking edits between two live sessions without reverting the source", async () => {
		const initialModel = getBundledModel(PROVIDER, INITIAL_MODEL_ID);
		if (!initialModel) throw new Error(`Expected bundled model ${PROVIDER}/${INITIAL_MODEL_ID}`);
		const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		const writerSession = new AgentSession({
			agent: new Agent({
				initialState: {
					model: initialModel,
					thinkingLevel: Effort.Medium,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				streamFn: mock.stream,
			}),
			sessionManager: SessionManager.inMemory(),
			settings: writer,
			modelRegistry,
		});

		try {
			writerSession.setThinkingLevel(Effort.High, true);
			await writer.flush();
			await waitFor(
				() =>
					cfgDefaultThinkingLevel.get(peer) === Effort.High &&
					writerSession.thinkingLevel === Effort.High &&
					session.thinkingLevel === Effort.High,
			);

			// Exact user scenario: terminal 1 changes shared profile high → medium.
			session.setThinkingLevel(Effort.Medium, true);
			await peer.flush();
			// No manual sync: writer watcher must update terminal 2 and its live session.
			await waitFor(
				() =>
					cfgDefaultThinkingLevel.get(writer) === Effort.Medium &&
					cfgDefaultThinkingLevel.get(peer) === Effort.Medium &&
					writerSession.thinkingLevel === Effort.Medium &&
					session.thinkingLevel === Effort.Medium,
			);

			expect(profileSnapshot(writer, "selected")?.defaultThinkingLevel).toBe(Effort.Medium);
			expect(profileSnapshot(peer, "selected")?.defaultThinkingLevel).toBe(Effort.Medium);
		} finally {
			await writerSession.dispose();
		}
	});

	it("preserves local live model and thinking edits across unrelated external writes", async () => {
		peer.setModelRole("default", `${PROVIDER}/${FALLBACK_MODEL_ID}`);
		cfgDefaultThinkingLevel.set(peer, Effort.XHigh);
		await peer.flush();
		await session.applyProfileToSession();

		writer.setProfileItem("external-only", {
			modelRoles: { default: `${PROVIDER}/${INITIAL_MODEL_ID}` },
			defaultThinkingLevel: Effort.Low,
		});
		await writer.flush();

		await waitFor(() => "external-only" in cfgProfilesItems.get(peer));
		expect(cfgProfilesActive.get(peer)).toBe("selected");
		expect(peer.getModelRole("default")).toBe(`${PROVIDER}/${FALLBACK_MODEL_ID}`);
		expect(cfgDefaultThinkingLevel.get(peer)).toBe(Effort.XHigh);
		expect(session.model?.id).toBe(FALLBACK_MODEL_ID);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});
	it("keeps the selected profile and live session when another terminal deletes its definition", async () => {
		cfgModelRoles.override(peer, { default: "google/gemini-stale" });

		writer.deleteProfileItem("selected");
		await writer.flush();
		await peer.syncFromDisk();

		expect(cfgProfilesActive.get(peer)).toBe("selected");
		expect(peer.getModelRole("default")).toBe("google/gemini-stale");
		expect(session.model?.id).toBe(INITIAL_MODEL_ID);
		expect(cfgProfilesItems.get(peer)).toHaveProperty("selected");
	});

	it("syncs an inactive deletion without changing the selected live model", async () => {
		writer.deleteProfileItem("inactive");
		await writer.flush();

		await waitFor(() => !("inactive" in cfgProfilesItems.get(peer)));
		expect(cfgProfilesActive.get(peer)).toBe("selected");
		expect(peer.getModelRole("default")).toBe(`${PROVIDER}/${INITIAL_MODEL_ID}`);
		expect(session.model?.id).toBe(INITIAL_MODEL_ID);
	});

	it("fences a synchronized profile apply queued during async prompt setup before provider dispatch", async () => {
		const apiKeyLookupStarted = Promise.withResolvers<void>();
		const releaseApiKeyLookup = Promise.withResolvers<void>();
		const applyStarted = Promise.withResolvers<void>();
		const releaseApply = Promise.withResolvers<void>();
		const providerCalled = Promise.withResolvers<void>();
		const getApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementationOnce(async (model, sessionId) => {
			apiKeyLookupStarted.resolve();
			await releaseApiKeyLookup.promise;
			return getApiKey(model, sessionId);
		});
		const setModel = session.setModel.bind(session);
		vi.spyOn(session, "setModel").mockImplementation(async (model, role, options) => {
			applyStarted.resolve();
			await releaseApply.promise;
			return setModel(model, role, options);
		});

		onProviderCall = () => providerCalled.resolve();
		const prompting = session.prompt("use synchronized profile");
		await apiKeyLookupStarted.promise;
		writer.setProfileItem("selected", {
			modelRoles: { default: `${PROVIDER}/${FALLBACK_MODEL_ID}` },
			defaultThinkingLevel: Effort.High,
		});
		await writer.flush();
		await peer.syncFromDisk();
		await applyStarted.promise;
		releaseApiKeyLookup.resolve();

		try {
			// No event exists for "still blocked"; bounded race observes externally visible provider dispatch.
			const dispatchedWhileApplyBlocked = await Promise.race([
				providerCalled.promise.then(() => true),
				Bun.sleep(100).then(() => false),
			]);
			expect(dispatchedWhileApplyBlocked).toBe(false);
		} finally {
			releaseApiKeyLookup.resolve();
			releaseApply.resolve();
		}

		expect(await prompting).toBe(false);
		expect(requestedModels).toEqual([]);
	});
	it("applies a queued profile before model-dependent prompt preprocessing", async () => {
		const applyStarted = Promise.withResolvers<void>();
		const releaseApply = Promise.withResolvers<void>();
		const setModel = session.setModel.bind(session);
		vi.spyOn(session, "setModel").mockImplementation(async (model, role, options) => {
			applyStarted.resolve();
			await releaseApply.promise;
			return setModel(model, role, options);
		});

		writer.setProfileItem("selected", {
			modelRoles: { default: `${PROVIDER}/${FALLBACK_MODEL_ID}` },
			defaultThinkingLevel: Effort.High,
		});
		await writer.flush();
		await peer.syncFromDisk();
		await applyStarted.promise;
		cfgExternalThinking.set(peer, true);

		const preprocessingModels: Array<string | undefined> = [];
		const getEnabledToolNames = session.getEnabledToolNames.bind(session);
		vi.spyOn(session, "getEnabledToolNames").mockImplementation(() => {
			preprocessingModels.push(session.model?.id);
			return getEnabledToolNames();
		});

		const prompting = session.prompt("preprocess with synchronized profile");
		releaseApply.resolve();
		await prompting;

		expect(preprocessingModels).not.toContain(INITIAL_MODEL_ID);
		expect(preprocessingModels).toContain(FALLBACK_MODEL_ID);
		expect(requestedModels).toEqual([FALLBACK_MODEL_ID]);
	});

	it("does not continue an async profile apply after disposal begins", async () => {
		const applyStarted = Promise.withResolvers<void>();
		const releaseApply = Promise.withResolvers<void>();
		const initialThinking = session.thinkingLevel;
		vi.spyOn(session, "setModel").mockImplementation(async model => {
			session.agent.setModel(model);
			applyStarted.resolve();
			await releaseApply.promise;
			return { switched: true };
		});

		peer.setModelRole("default", `${PROVIDER}/${FALLBACK_MODEL_ID}`);
		cfgDefaultThinkingLevel.set(peer, Effort.High);
		const applying = session.applyProfileToSession();
		await applyStarted.promise;

		session.beginDispose();
		releaseApply.resolve();
		await applying;

		expect(session.thinkingLevel).toBe(initialThinking);
	});

	it("bounds disposal when a synchronized profile apply never settles", async () => {
		const applyStarted = Promise.withResolvers<void>();
		const neverSettles = new Promise<void>(() => {});
		vi.spyOn(session, "applyProfileToSession").mockImplementation(async () => {
			applyStarted.resolve();
			await neverSettles;
		});

		writer.setProfileItem("selected", {
			modelRoles: { default: `${PROVIDER}/${FALLBACK_MODEL_ID}` },
			defaultThinkingLevel: Effort.High,
		});
		await writer.flush();
		await peer.syncFromDisk();
		await applyStarted.promise;

		vi.useFakeTimers();
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const disposing = session.dispose();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		vi.advanceTimersByTime(5_000);
		await disposing;

		expect(session.isDisposed).toBe(true);
		expect(warn).toHaveBeenCalledWith(
			"Synchronized profile apply still draining at dispose deadline",
			expect.objectContaining({ error: "Error: Timed out draining synchronized profile apply during dispose" }),
		);
	});

	it("stops a cloned settings watcher when its owning session is disposed", async () => {
		await session.dispose();
		writer.deleteProfileItem("selected");
		await writer.flush();
		await Bun.sleep(400);
		// Peer was disposed, so it did not run deletion sync
		expect(cfgProfilesActive.get(peer)).toBe("selected");
	});

	it("binds resumed settings to the recorded profile without changing the durable active marker", async () => {
		expect(peer.bindSessionToProfile("fallback")).toBe(true);
		expect(cfgProfilesActive.get(peer)).toBe("fallback");
		expect(peer.getModelRole("default")).toBe(`${PROVIDER}/${FALLBACK_MODEL_ID}`);
		expect(cfgDefaultThinkingLevel.get(peer)).toBe(Effort.High);
		expect(peer.bindSessionToProfile("does-not-exist")).toBe(false);

		// Binding is terminal-local: the next save keeps the startup marker.
		await peer.flush();
		await writer.syncFromDisk();
		expect(cfgProfilesActive.get(writer)).toBe("selected");
	});

	it("routes persisted model edits to the bound profile, not the startup default", async () => {
		const selectedModel = "openai/gpt-5";
		writer.setProfileItem("selected", {
			modelRoles: { default: selectedModel },
			defaultThinkingLevel: Effort.Low,
		});
		await writer.flush();
		await peer.syncFromDisk();

		expect(peer.bindSessionToProfile("fallback")).toBe(true);
		peer.setModelRole("default", `${PROVIDER}/${INITIAL_MODEL_ID}`);
		await peer.flush();
		await writer.syncFromDisk();

		const items = cfgProfilesItems.get(writer) as Record<
			string,
			{ modelRoles: Record<string, string>; defaultThinkingLevel: string }
		>;
		expect(items.fallback.modelRoles.default).toBe(`${PROVIDER}/${INITIAL_MODEL_ID}`);
		expect(items.selected.modelRoles.default).toBe(selectedModel);
	});

	it("keeps a legacy unbound resumed session from auto-applying the disk-active profile", async () => {
		const fallbackModel = getBundledModel(PROVIDER, FALLBACK_MODEL_ID);
		if (!fallbackModel) throw new Error(`Expected bundled model ${PROVIDER}/${FALLBACK_MODEL_ID}`);
		const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		const legacySession = new AgentSession({
			agent: new Agent({
				initialState: {
					model: fallbackModel,
					thinkingLevel: Effort.High,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				streamFn: mock.stream,
			}),
			sessionManager: SessionManager.inMemory(),
			settings: peer,
			modelRegistry,
			sessionProfile: null,
		});

		try {
			expect(legacySession.getSessionProfileName()).toBeUndefined();
			// Resume of an unbound legacy session retires profile ownership so
			// persisted edits cannot land in the startup-default snapshot.
			peer.unbindSessionFromProfile();
			expect(cfgProfilesActive.get(peer)).toBe("");
			peer.setModelRole("default", `${PROVIDER}/${FALLBACK_MODEL_ID}`);
			await peer.flush();
			const items = cfgProfilesItems.get(peer) as Record<
				string,
				{ modelRoles: Record<string, string>; defaultThinkingLevel: string }
			>;
			expect(items.selected.modelRoles.default).toBe(`${PROVIDER}/${INITIAL_MODEL_ID}`);
			expect(items.fallback.modelRoles.default).toBe(`${PROVIDER}/${FALLBACK_MODEL_ID}`);

			// Disk-active profile "selected" wants INITIAL_MODEL_ID; a peer edit
			// must not re-pin the legacy session's runtime model to it either.
			writer.setProfileItem("related", {
				modelRoles: { default: `${PROVIDER}/${INITIAL_MODEL_ID}` },
				defaultThinkingLevel: Effort.Medium,
			});
			await writer.flush();
			await peer.syncFromDisk();
			await Bun.sleep(150);
			expect(legacySession.model?.id).toBe(FALLBACK_MODEL_ID);

			// An explicit switch binds and re-pins.
			expect(await legacySession.bindSessionProfile("selected")).toBe(true);
			expect(legacySession.getSessionProfileName()).toBe("selected");
			expect(legacySession.sessionManager.getSessionProfile()).toBe("selected");
			expect(legacySession.model?.id).toBe(INITIAL_MODEL_ID);
		} finally {
			await legacySession.dispose();
		}
	});

	it("reports an unavailable configured default and rejects prompts with the same selector", async () => {
		const staleSelector = "google/gemini-stale";
		peer.setModelRole("default", staleSelector);
		await peer.flush();

		const state = session.getConfiguredDefaultModelState();
		expect(state.configuredSelector).toBe(staleSelector);
		expect(state.resolvedModel).toBeUndefined();
		expect(state.runtimeModel?.id).toBe(INITIAL_MODEL_ID);
		expect(state.unavailable).toBe(true);

		await expect(session.prompt("preflight naming")).rejects.toThrow(
			/Default model "google\/gemini-stale" is unavailable/,
		);
		expect(requestedModels).toEqual([]);
	});
});
