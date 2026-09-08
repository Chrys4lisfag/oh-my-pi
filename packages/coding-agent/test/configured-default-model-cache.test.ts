/**
 * `getConfiguredDefaultModelState()` is memoized, and the cache must never
 * outlive what it was derived from.
 *
 * The status line calls this once per repaint — i.e. per keystroke — and the
 * resolution walks `ModelRegistry.getAvailable()`, which recomposes and
 * collapses the entire static catalog (measured 24-42ms at ~15k models). That
 * made typing latency scale with the configured provider set: 78ms per key
 * (12.8 fps) at 90 providers versus 11ms (90 fps) with the memo.
 *
 * The staleness risk this pins: a configured default that is unavailable at
 * boot and becomes resolvable after late discovery must stop reporting
 * `unavailable`, and a role edit must be observed immediately.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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
import { TempDir } from "@oh-my-pi/pi-utils";

const PROVIDER = "anthropic";
const MODEL_ID = "claude-sonnet-4-5";

describe("configured default model state cache", () => {
	let tempDir: TempDir;
	let settings: Settings;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-default-model-cache-");
		settings = await Settings.loadIsolated({ cwd: tempDir.path(), agentDir: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey(PROVIDER, "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel(PROVIDER, MODEL_ID);
		if (!model) throw new Error(`Expected bundled model ${PROVIDER}/${MODEL_ID}`);
		const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		const agent = new Agent({
			initialState: {
				model,
				thinkingLevel: Effort.Medium,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (m, context, options) => mock.stream(m, context, options),
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
	});

	afterEach(async () => {
		if (session) await session.dispose();
		resetSettingsForTest();
		AgentStorage.close();
		if (authStorage) authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
	});

	it("serves repeated calls without re-resolving the catalog", () => {
		settings.setModelRole("default", `${PROVIDER}/${MODEL_ID}`);
		let resolves = 0;
		const original = modelRegistry.getAvailable.bind(modelRegistry);
		modelRegistry.getAvailable = () => {
			resolves++;
			return original();
		};

		const first = session.getConfiguredDefaultModelState();
		const resolvesAfterFirst = resolves;
		for (let i = 0; i < 20; i++) session.getConfiguredDefaultModelState();

		expect(first.configuredSelector).toBe(`${PROVIDER}/${MODEL_ID}`);
		// 20 further repaints must not add catalog walks.
		expect(resolves).toBe(resolvesAfterFirst);
	});

	it("observes a role change immediately", () => {
		settings.setModelRole("default", `${PROVIDER}/${MODEL_ID}`);
		expect(session.getConfiguredDefaultModelState().configuredSelector).toBe(`${PROVIDER}/${MODEL_ID}`);

		settings.setModelRole("default", "openai/gpt-4o-mini");
		const next = session.getConfiguredDefaultModelState();
		expect(next.configuredSelector).toBe("openai/gpt-4o-mini");
	});

	it("stops reporting unavailable after late discovery, with the selector unchanged", async () => {
		// `openai` has no credential in this sandbox, so the configured default
		// resolves to nothing and the status line shows `[unavailable]`.
		settings.setModelRole("default", "openai/gpt-4o-mini");
		expect(session.getConfiguredDefaultModelState().unavailable).toBe(true);

		// Credential arrives and the catalog settles. The SELECTOR never changes,
		// so only invalidation via `onModelsUpdated` can surface the new
		// resolution — a selector-keyed memo alone would keep saying unavailable.
		authStorage.setRuntimeApiKey("openai", "test-key");
		await modelRegistry.refresh("offline");

		const after = session.getConfiguredDefaultModelState();
		expect(after.configuredSelector).toBe("openai/gpt-4o-mini");
		expect(after.unavailable).toBe(false);
		expect(after.resolvedModel?.id).toBe("gpt-4o-mini");
	});

	it("always reports the live runtime model, never a cached one", () => {
		settings.setModelRole("default", `${PROVIDER}/${MODEL_ID}`);
		const first = session.getConfiguredDefaultModelState();
		expect(first.runtimeModel?.id).toBe(MODEL_ID);

		// The runtime model moves independently of the configured default (role
		// cycling, retry fallback); a memo keyed only on the selector must not
		// pin it.
		const other = getBundledModel("openai", "gpt-4o-mini");
		if (other) {
			session.agent.state.model = other;
			expect(session.getConfiguredDefaultModelState().runtimeModel?.id).toBe(other.id);
		}
	});
});
