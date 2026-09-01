import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import {
	addProfile,
	cycleProfile,
	deleteProfile,
	getActiveProfileName,
	switchProfile,
} from "@oh-my-pi/pi-coding-agent/config/profiles";
import { resetSettingsForTest, resetSettingsForTestAsync, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

const EDU = {
	modelRoles: { default: "openai-codex/gpt-5.6-sol:medium", smol: "entrim-ai/deepseek-v4-flash:high" },
	defaultThinkingLevel: "medium",
};
const CYBER = {
	modelRoles: { default: "openai-codex/gpt-daybreak-blue-latest:medium" },
	defaultThinkingLevel: "medium",
};
const EDU_UPDATED = {
	modelRoles: { default: "openai-codex/gpt-5.6-sol:high", smol: "entrim-ai/deepseek-v4-flash:high" },
	defaultThinkingLevel: "high",
};

const RUNTIME_PROVIDER = "anthropic";
const RUNTIME_MODEL_ID = "claude-sonnet-4-5";
const LATE_PROVIDER = "kimi-code";
const LATE_MODEL_ID = "kimi-for-coding";

type Snapshot = { modelRoles: Record<string, string>; defaultThinkingLevel: string };

function snapshot(settings: Settings, name: string): Snapshot | undefined {
	return settings.get("profiles.items")[name] as Snapshot | undefined;
}

function isolatedProfiles(items: Record<string, Snapshot>, active: string): Settings {
	const local = Settings.isolated();
	local.set("profiles.items", items);
	local.set("profiles.active", active);
	const selected = items[active];
	if (selected) {
		local.set("modelRoles", selected.modelRoles);
		local.set("defaultThinkingLevel", selected.defaultThinkingLevel as never);
	}
	return local;
}

async function createSessionHarness(settings: Settings): Promise<{
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	sessionManager: SessionManager;
	session: AgentSession;
	dispose: () => Promise<void>;
}> {
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey(RUNTIME_PROVIDER, "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const runtimeModel = getBundledModel(RUNTIME_PROVIDER, RUNTIME_MODEL_ID);
	if (!runtimeModel) throw new Error(`Expected bundled model ${RUNTIME_PROVIDER}/${RUNTIME_MODEL_ID}`);
	const sessionManager = SessionManager.inMemory();
	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				model: runtimeModel,
				thinkingLevel: Effort.Medium,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		}),
		sessionManager,
		settings,
		modelRegistry,
	});
	return {
		authStorage,
		modelRegistry,
		sessionManager,
		session,
		dispose: async () => {
			await session.dispose();
			authStorage.close();
		},
	};
}

describe("terminal-pinned profile identity", () => {
	let dir: string;

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-profile-identity-"));
	});

	afterEach(async () => {
		AgentStorage.resetInstance();
		await resetSettingsForTestAsync();
		await removeWithRetries(dir);
	});

	async function load(): Promise<Settings> {
		return Settings.loadIsolated({ agentDir: dir, cwd: dir });
	}

	async function seeded(): Promise<{ terminal: Settings; peer: Settings }> {
		const seed = await load();
		seed.setProfileItem("gpt-edu", EDU);
		seed.setProfileItem("gpt-cyber-blue", CYBER);
		seed.activateProfile("gpt-edu", EDU);
		await seed.flush();
		return { terminal: await load(), peer: await load() };
	}

	function rewrite(mutator: (config: Record<string, any>) => void): void {
		const file = path.join(dir, "config.yml");
		const config = YAML.parse(fsSync.readFileSync(file, "utf8")) as Record<string, any>;
		mutator(config);
		fsSync.writeFileSync(file, YAML.stringify(config, null, 2));
	}

	it("01 external active marker never switches terminal", async () => {
		const { terminal, peer } = await seeded();
		peer.activateProfile("gpt-cyber-blue", CYBER);
		await peer.flush();
		await terminal.syncFromDisk();
		expect(terminal.activeProfileName()).toBe("gpt-edu");
	});

	it("02 external root projection never switches terminal", async () => {
		const { terminal } = await seeded();
		rewrite(config => {
			config.profiles.active = "gpt-cyber-blue";
			config.modelRoles = CYBER.modelRoles;
			config.defaultThinkingLevel = CYBER.defaultThinkingLevel;
		});
		await terminal.syncFromDisk();
		expect(terminal.activeProfileName()).toBe("gpt-edu");
		expect(terminal.getModelRole("default")).toBe(EDU.modelRoles.default);
	});

	it("03 unrelated profile edit preserves terminal profile", async () => {
		const { terminal, peer } = await seeded();
		peer.setProfileItem("gpt-cyber-blue", { ...CYBER, defaultThinkingLevel: "high" });
		await peer.flush();
		await terminal.syncFromDisk();
		expect(terminal.activeProfileName()).toBe("gpt-edu");
		expect(terminal.get("defaultThinkingLevel")).toBe(Effort.Medium);
	});

	it("04 same-profile model edit synchronizes models", async () => {
		const { terminal, peer } = await seeded();
		peer.bindSessionToProfile("gpt-edu");
		peer.setModelRole("default", EDU_UPDATED.modelRoles.default);
		await peer.flush();
		await terminal.syncFromDisk();
		expect(terminal.getModelRole("default")).toBe(EDU_UPDATED.modelRoles.default);
	});

	it("05 same-profile edit preserves profile identity", async () => {
		const { terminal, peer } = await seeded();
		peer.bindSessionToProfile("gpt-edu");
		peer.set("defaultThinkingLevel", Effort.High);
		await peer.flush();
		await terminal.syncFromDisk();
		expect(terminal.activeProfileName()).toBe("gpt-edu");
		expect(terminal.get("defaultThinkingLevel")).toBe(Effort.High);
	});

	it("06 external active-profile deletion preserves identity and snapshot", async () => {
		const { terminal, peer } = await seeded();
		peer.deleteProfileItem("gpt-edu");
		await peer.flush();
		await terminal.syncFromDisk();
		expect(terminal.activeProfileName()).toBe("gpt-edu");
		expect(snapshot(terminal, "gpt-edu")).toEqual(EDU);
		const disk = YAML.parse(fsSync.readFileSync(path.join(dir, "config.yml"), "utf8")) as Record<string, any>;
		expect(disk.profiles.items["gpt-edu"]).toBeUndefined();
	});

	it("07 external malformed profile preserves identity and last snapshot", async () => {
		const { terminal } = await seeded();
		rewrite(config => {
			config.profiles.items["gpt-edu"] = { modelRoles: { default: 7 }, defaultThinkingLevel: "high" };
			config.profiles.active = "gpt-cyber-blue";
		});
		await terminal.syncFromDisk();
		expect(terminal.activeProfileName()).toBe("gpt-edu");
		expect(snapshot(terminal, "gpt-edu")).toEqual(EDU);
	});

	it("08 removing every persisted profile preserves active identity", async () => {
		const { terminal } = await seeded();
		rewrite(config => {
			config.profiles.items = {};
			config.profiles.active = "";
		});
		await terminal.syncFromDisk();
		expect(terminal.activeProfileName()).toBe("gpt-edu");
		expect(terminal.getModelRole("default")).toBe(EDU.modelRoles.default);
	});

	it("09 resume ignores the disk active profile", async () => {
		const { terminal } = await seeded();
		const manager = SessionManager.inMemory();
		await manager.setSessionProfile("gpt-edu", EDU);
		rewrite(config => {
			config.profiles.active = "gpt-cyber-blue";
			config.modelRoles = CYBER.modelRoles;
		});
		await terminal.reloadFromDisk();
		expect(terminal.bindSessionToProfile(manager.getSessionProfile()!, manager.getSessionProfileSnapshot())).toBe(
			true,
		);
		expect(terminal.activeProfileName()).toBe("gpt-edu");
	});

	it("10 resume restores a missing profile from its session snapshot", async () => {
		const { terminal } = await seeded();
		rewrite(config => delete config.profiles.items["gpt-edu"]);
		await terminal.reloadFromDisk();
		expect(terminal.bindSessionToProfile("gpt-edu", EDU)).toBe(true);
		expect(snapshot(terminal, "gpt-edu")).toEqual(EDU);
	});

	it("11 resume restores a malformed profile from its session snapshot", async () => {
		const { terminal } = await seeded();
		rewrite(config => (config.profiles.items["gpt-edu"] = { broken: true }));
		await terminal.reloadFromDisk();
		expect(terminal.bindSessionToProfile("gpt-edu", EDU)).toBe(true);
		expect(terminal.getModelRole("default")).toBe(EDU.modelRoles.default);
	});

	it("12 unavailable model preserves settings, session, and header identity with the prior runtime", async () => {
		const unavailableSelector = "missing/model";
		const local = isolatedProfiles(
			{ unavailable: { modelRoles: { default: unavailableSelector }, defaultThinkingLevel: "high" } },
			"unavailable",
		);
		const harness = await createSessionHarness(local);
		try {
			expect(await harness.session.bindSessionProfile("unavailable")).toBe(true);

			const state = harness.session.getConfiguredDefaultModelState();
			expect(local.activeProfileName()).toBe("unavailable");
			expect(local.getModelRole("default")).toBe(unavailableSelector);
			expect(harness.session.getSessionProfileName()).toBe("unavailable");
			expect(harness.sessionManager.getSessionProfile()).toBe("unavailable");
			expect(harness.sessionManager.getSessionProfileSnapshot()?.modelRoles.default).toBe(unavailableSelector);
			expect(state).toMatchObject({
				configuredSelector: unavailableSelector,
				unavailable: true,
			});
			expect(state.resolvedModel).toBeUndefined();
			expect(state.runtimeModel?.id).toBe(RUNTIME_MODEL_ID);
			expect(harness.session.model?.id).toBe(RUNTIME_MODEL_ID);
		} finally {
			await harness.dispose();
		}
	});

	it("13 slash-style switch changes only the supplied settings instance", () => {
		const first = isolatedProfiles({ edu: EDU, cyber: CYBER }, "edu");
		const second = isolatedProfiles({ edu: EDU, cyber: CYBER }, "edu");
		switchProfile("cyber", first);
		expect(getActiveProfileName(first)).toBe("cyber");
		expect(getActiveProfileName(second)).toBe("edu");
	});

	it("14 keybind-style cycle uses the supplied session settings", () => {
		const local = isolatedProfiles({ edu: EDU, cyber: CYBER }, "edu");
		expect(cycleProfile(local)?.name).toBe("cyber");
		expect(local.activeProfileName()).toBe("cyber");
	});

	it("15 keybind-style cycle reports the newly selected profile", () => {
		const local = isolatedProfiles({ alpha: EDU, beta: CYBER }, "alpha");
		const result = cycleProfile(local);
		expect(result).toMatchObject({ name: "beta", snapshot: CYBER });
	});

	it("16 keybind-style cycle ignores stale singleton profile state", () => {
		Settings.instance.set("profiles.items", { stale: EDU, zzz: CYBER });
		Settings.instance.set("profiles.active", "stale");
		const local = isolatedProfiles({ alpha: EDU, beta: CYBER }, "alpha");
		expect(cycleProfile(local)?.name).toBe("beta");
		expect(Settings.instance.get("profiles.active")).toBe("stale");
	});

	it("17 keybind-style cycle leaves peer active profile unchanged", () => {
		const first = isolatedProfiles({ edu: EDU, cyber: CYBER }, "edu");
		const peer = isolatedProfiles({ edu: EDU, cyber: CYBER }, "edu");
		cycleProfile(first);
		expect(peer.activeProfileName()).toBe("edu");
	});

	it("18 adding a profile changes only the supplied terminal", () => {
		const first = isolatedProfiles({ edu: EDU }, "edu");
		const peer = isolatedProfiles({ edu: EDU }, "edu");
		addProfile("new", CYBER, first);
		expect(first.activeProfileName()).toBe("new");
		expect(peer.activeProfileName()).toBe("edu");
	});

	it("19 deleting the active profile removes its durable definition but retains the local ghost and runtime", async () => {
		const { terminal } = await seeded();
		deleteProfile("gpt-edu", terminal);
		await terminal.flush();

		const disk = YAML.parse(fsSync.readFileSync(path.join(dir, "config.yml"), "utf8")) as Record<string, any>;
		expect(disk.profiles.items["gpt-edu"]).toBeUndefined();
		expect(snapshot(terminal, "gpt-edu")).toEqual(EDU);
		expect(terminal.activeProfileName()).toBe("gpt-edu");
		expect(terminal.getModelRole("default")).toBe(EDU.modelRoles.default);
	});

	it("20 late ModelRegistry discovery applies the pending model without changing identity", async () => {
		const lateSelector = `${LATE_PROVIDER}/${LATE_MODEL_ID}`;
		const local = isolatedProfiles(
			{
				runtime: {
					modelRoles: { default: `${RUNTIME_PROVIDER}/${RUNTIME_MODEL_ID}` },
					defaultThinkingLevel: "medium",
				},
				late: { modelRoles: { default: lateSelector }, defaultThinkingLevel: "high" },
			},
			"runtime",
		);
		const harness = await createSessionHarness(local);
		try {
			expect(await harness.session.bindSessionProfile("late")).toBe(true);
			expect(harness.session.getConfiguredDefaultModelState().unavailable).toBe(true);
			expect(harness.session.model?.id).toBe(RUNTIME_MODEL_ID);

			harness.authStorage.setRuntimeApiKey(LATE_PROVIDER, "test-key");
			await harness.modelRegistry.refresh();
			await harness.session.waitForIdle();

			expect(local.activeProfileName()).toBe("late");
			expect(local.getModelRole("default")).toBe(lateSelector);
			expect(harness.session.getSessionProfileName()).toBe("late");
			expect(harness.sessionManager.getSessionProfile()).toBe("late");
			expect(harness.sessionManager.getSessionProfileSnapshot()?.modelRoles.default).toBe(lateSelector);
			expect(harness.session.getConfiguredDefaultModelState().unavailable).toBe(false);
			expect(harness.session.model?.provider).toBe(LATE_PROVIDER);
			expect(harness.session.model?.id).toBe(LATE_MODEL_ID);
		} finally {
			await harness.dispose();
		}
	});
});
