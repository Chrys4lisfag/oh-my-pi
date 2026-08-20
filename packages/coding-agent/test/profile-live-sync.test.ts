import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

const PROVIDER = "anthropic";
const INITIAL_MODEL_ID = "claude-sonnet-4-5";
const FALLBACK_MODEL_ID = "claude-haiku-4-5";

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
		writer.set("profiles.active", "selected");
		writer.set("modelRoles", { default: `${PROVIDER}/${INITIAL_MODEL_ID}` });
		writer.set("defaultThinkingLevel", Effort.Medium);
		await writer.flush();

		peer = await writer.cloneForCwd(tempDir.path());
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey(PROVIDER, "test-key");
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
		AgentStorage.resetInstance();
		if (authStorage) authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
	});

	it("does not switch other running sessions when one terminal switches active profile", async () => {
		writer.activateProfile("fallback", {
			modelRoles: { default: `${PROVIDER}/${FALLBACK_MODEL_ID}` },
			defaultThinkingLevel: Effort.High,
		});
		await writer.flush();

		await Bun.sleep(400);

		// Peer was on "selected" and "selected" still exists on disk, so peer must STAY on "selected"
		expect(peer.get("profiles.active")).toBe("selected");
		expect(peer.getModelRole("default")).toBe(`${PROVIDER}/${INITIAL_MODEL_ID}`);
		expect(session.model?.id).toBe(INITIAL_MODEL_ID);
		expect(peer.get("defaultThinkingLevel")).toBe(Effort.Medium);
	});

	it("does not switch other running sessions when one terminal updates its model roles", async () => {
		writer.setModelRole("default", `${PROVIDER}/${FALLBACK_MODEL_ID}`);
		await writer.flush();

		await Bun.sleep(400);

		// Peer keeps its active profile snapshot
		expect(peer.get("profiles.active")).toBe("selected");
		expect(peer.getModelRole("default")).toBe(`${PROVIDER}/${INITIAL_MODEL_ID}`);
		expect(session.model?.id).toBe(INITIAL_MODEL_ID);
	});

	it("preserves local live model and thinking edits across unrelated external writes", async () => {
		peer.setModelRole("default", `${PROVIDER}/${FALLBACK_MODEL_ID}`);
		peer.set("defaultThinkingLevel", Effort.XHigh);
		await peer.flush();
		await session.applyProfileToSession();

		writer.setProfileItem("external-only", {
			modelRoles: { default: `${PROVIDER}/${INITIAL_MODEL_ID}` },
			defaultThinkingLevel: Effort.Low,
		});
		await writer.flush();

		await waitFor(() => "external-only" in peer.get("profiles.items"));
		expect(peer.get("profiles.active")).toBe("selected");
		expect(peer.getModelRole("default")).toBe(`${PROVIDER}/${FALLBACK_MODEL_ID}`);
		expect(peer.get("defaultThinkingLevel")).toBe(Effort.XHigh);
		expect(session.model?.id).toBe(FALLBACK_MODEL_ID);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});
	it("autoswitches settings and the live session when another terminal deletes the selected profile", async () => {
		peer.overrideModelRoles({ default: "google/gemini-stale" });

		writer.deleteProfileItem("selected");
		await writer.flush();

		await waitFor(
			() =>
				peer.get("profiles.active") === "fallback" &&
				peer.getModelRole("default") === `${PROVIDER}/${FALLBACK_MODEL_ID}` &&
				session.model?.id === FALLBACK_MODEL_ID &&
				session.thinkingLevel === Effort.High,
		);
		expect(peer.get("profiles.items")).not.toHaveProperty("selected");
	});

	it("syncs an inactive deletion without changing the selected live model", async () => {
		writer.deleteProfileItem("inactive");
		await writer.flush();

		await waitFor(() => !("inactive" in peer.get("profiles.items")));
		expect(peer.get("profiles.active")).toBe("selected");
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
		writer.deleteProfileItem("selected");
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

		writer.deleteProfileItem("selected");
		await writer.flush();
		await peer.syncFromDisk();
		await applyStarted.promise;
		peer.set("externalThinking", true);

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
		peer.set("defaultThinkingLevel", Effort.High);
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

		writer.deleteProfileItem("selected");
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
		expect(peer.get("profiles.active")).toBe("selected");
	});
});
