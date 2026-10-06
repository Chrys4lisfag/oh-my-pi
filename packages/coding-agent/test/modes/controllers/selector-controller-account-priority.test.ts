import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { cfgAuthAccountPolicies } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import {
	createAuthStorageSettingsSync,
	type AuthStorageSettingsSync,
} from "@oh-my-pi/pi-coding-agent/session/auth-broker-config";
import { setAccountPriority } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/account-priority";
import type { StoredAuthCredential } from "@oh-my-pi/pi-ai/auth-storage";
import { AccountManagerSelectorComponent } from "@oh-my-pi/pi-tui/overlays/account-manager-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

beforeAll(() => initTheme());

describe("account priority persistence", () => {
	let dir: TempDir;
	let settings: Settings;
	let auth: AuthStorage;
	let sync: AuthStorageSettingsSync | undefined;
	beforeEach(async () => {
		dir = TempDir.createSync("omp-account-priority-");
		settings = await Settings.loadIsolated({ agentDir: dir.path(), cwd: dir.path() });
		auth = await AuthStorage.create(dir.join("auth.db"));
		await auth.credentials.set("anthropic", [
			{
				type: "oauth",
				access: "personal",
				refresh: "personal-refresh",
				expires: Date.now() + 60_000,
				email: "shared@example.test",
				accountId: "shared",
				orgId: "personal",
			},
			{
				type: "oauth",
				access: "team",
				refresh: "team-refresh",
				expires: Date.now() + 60_000,
				email: "shared@example.test",
				accountId: "shared",
				orgId: "team",
			},
		]);
	});
	afterEach(async () => {
		sync?.stop();
		sync = undefined;
		await settings.dispose();
		auth.close();
		AgentStorage.close();
		vi.restoreAllMocks();
		Bun.gc(true);
		dir.removeSync();
	});

	async function open(): Promise<AccountManagerSelectorComponent> {
		const controller = new SelectorController(
			createInteractiveModeContext({ settings, session: { modelRegistry: { authStorage: auth } } }),
		);
		let selector: AccountManagerSelectorComponent | undefined;
		vi.spyOn(controller, "showSelector").mockImplementation(create => {
			const component = create(() => {}).component;
			if (!(component instanceof AccountManagerSelectorComponent)) throw new Error("Expected account manager");
			selector = component;
		});
		await controller.showAccountsSelector("anthropic");
		if (!selector) throw new Error("Account manager was not opened");
		return selector;
	}

	it("allows a single routing-disabled account to receive a priority without enabling it", async () => {
		await auth.credentials.set("anthropic", {
			type: "oauth",
			access: "single",
			refresh: "refresh",
			expires: Date.now() + 60_000,
			email: "single@example.test",
			accountId: "single",
		});
		const row = auth.credentials.list("anthropic")[0]!;
		auth.credentials.setRoutingEnabled("anthropic", row.id, false);
		const component = await open();
		await component.handleInput("+");
		expect(cfgAuthAccountPolicies.get(settings)).toEqual([
			{ provider: "anthropic", account: { email: "single@example.test", accountId: "single" }, priority: 1 },
		]);
		expect(auth.credentials.isRoutingDisabled(row.id)).toBe(true);
	});

	it("persists an org-specific priority, updates live auth, restores it on reopen, and keeps reserves on Auto", async () => {
		const reserve = {
			provider: "anthropic",
			account: { email: "shared@example.test", orgId: "personal" },
			reservePct: 15,
		};
		const unrelated = { provider: "other", account: { accountId: "other-account" }, priority: 7, reservePct: 20 };
		cfgAuthAccountPolicies.set(settings, [reserve, unrelated]);
		await settings.flush();
		sync = createAuthStorageSettingsSync(settings, auth);
		expect(auth.oauth.identity("anthropic")).toEqual({
			email: "shared@example.test",
			accountId: "shared",
			orgId: "personal",
		});
		const component = await open();
		await component.handleInput("+");
		expect(cfgAuthAccountPolicies.get(settings)).toEqual([{ ...reserve, priority: 1 }, unrelated]);
		await sync.settled();
		expect(auth.oauth.policy("anthropic", { email: "shared@example.test", orgId: "personal" })?.priority).toBe(1);
		expect(auth.oauth.policy("anthropic", { email: "shared@example.test", orgId: "team" })).toBeUndefined();
		const reopened = await open();
		expect(
			reopened
				.render(160)
				.map(line => Bun.stripANSI(line))
				.join("\n"),
		).toContain("priority 1");
		const saved = await Settings.loadReadOnly({ agentDir: dir.path(), cwd: dir.path() });
		try {
			expect(cfgAuthAccountPolicies.get(saved)).toEqual([{ ...reserve, priority: 1 }, unrelated]);
		} finally {
			await saved.dispose();
		}
		await reopened.handleInput("a");
		await sync.settled();
		expect(cfgAuthAccountPolicies.get(settings)).toEqual([reserve, unrelated]);
		expect(auth.oauth.policy("anthropic", { email: "shared@example.test", orgId: "personal" })).toEqual(reserve);
	});

	it("creates policies from durable identity rather than row id and removes priority-only entries on Auto", async () => {
		const rows = auth.credentials.list("anthropic");
		const row = rows.find(row => row.credential.type === "oauth" && row.credential.orgId === "team")!;
		await setAccountPriority(settings, "anthropic", rows, row.id, 3);
		expect(cfgAuthAccountPolicies.get(settings)).toEqual([
			{
				provider: "anthropic",
				account: { email: "shared@example.test", accountId: "shared", orgId: "team" },
				priority: 3,
			},
		]);
		await setAccountPriority(
			settings,
			"anthropic",
			rows.map(item => ({ ...item, id: item.id + 100 })),
			row.id + 100,
			4,
		);
		expect(cfgAuthAccountPolicies.get(settings)[0]?.priority).toBe(4);
		await setAccountPriority(settings, "anthropic", rows, row.id, undefined);
		expect(cfgAuthAccountPolicies.get(settings)).toEqual([]);
	});

	it("rolls back a rejected durable write without claiming the new priority", async () => {
		const rows = auth.credentials.list("anthropic");
		const flush = settings.flush.bind(settings);
		let calls = 0;
		vi.spyOn(settings, "flush").mockImplementation(async () => {
			if (++calls === 2) throw new Error("Disk full");
			await flush();
		});
		await expect(setAccountPriority(settings, "anthropic", rows, rows[0]!.id, 2)).rejects.toThrow("Disk full");
		expect(cfgAuthAccountPolicies.get(settings)).toEqual([]);
		await settings.flush();
		const reopened = await Settings.loadReadOnly({ agentDir: dir.path(), cwd: dir.path() });
		try {
			expect(cfgAuthAccountPolicies.get(reopened)).toEqual([]);
		} finally {
			await reopened.dispose();
		}
	});

	it("rejects shadowed policies instead of reporting an ineffective global priority", async () => {
		cfgAuthAccountPolicies.override(settings, []);
		const rows = auth.credentials.list("anthropic");
		await expect(setAccountPriority(settings, "anthropic", rows, rows[0]!.id, 1)).rejects.toThrow("runtime settings");
		expect(settings.getGlobalSettings().auth).toBeUndefined();
	});

	it("rejects identities that are absent or match multiple OAuth accounts", async () => {
		const rows: StoredAuthCredential[] = [
			{
				id: 1,
				provider: "anthropic",
				disabledCause: null,
				credential: { type: "oauth", access: "a", refresh: "r", expires: 1 },
			},
		];
		await expect(setAccountPriority(settings, "anthropic", rows, 1, 1)).rejects.toThrow("no stable identity");
		const ambiguous = [1, 2].map(id => ({
			...rows[0]!,
			id,
			credential: { ...rows[0]!.credential, email: "duplicate@example.test" },
		}));
		await expect(setAccountPriority(settings, "anthropic", ambiguous, 1, 1)).rejects.toThrow(
			"matches 2 stored OAuth accounts",
		);
		expect(cfgAuthAccountPolicies.get(settings)).toEqual([]);
	});
});
