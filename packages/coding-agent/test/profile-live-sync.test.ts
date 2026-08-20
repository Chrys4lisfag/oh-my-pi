import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

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
		const agent = new Agent({
			initialState: {
				model: initialModel,
				thinkingLevel: Effort.Medium,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
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

	it("stops a cloned settings watcher when its owning session is disposed", async () => {
		await session.dispose();
		writer.deleteProfileItem("selected");
		await writer.flush();
		await Bun.sleep(400);
		// Peer was disposed, so it did not run deletion sync
		expect(peer.get("profiles.active")).toBe("selected");
	});
});
