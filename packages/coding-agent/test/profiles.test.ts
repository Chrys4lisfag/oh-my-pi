import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { cfgModelRoles } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { cfgProfilesActive, cfgProfilesItems } from "@oh-my-pi/pi-coding-agent/config/profiles";
import { cfgDefaultThinkingLevel } from "@oh-my-pi/pi-coding-agent/session/settings";
import {
	addProfile,
	captureCurrentSnapshot,
	captureProfileActivationState,
	cycleProfile,
	deleteProfile,
	ensureDefaultProfile,
	getActiveProfileName,
	listProfiles,
	renameProfile,
	restoreProfileActivation,
	saveActiveProfile,
	switchProfile,
} from "@oh-my-pi/pi-coding-agent/config/profiles";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
});

type TestProfileSnapshot = { modelRoles: Record<string, string>; defaultThinkingLevel: string };
function profileSnapshot(settings: Settings, name: string): TestProfileSnapshot | undefined {
	return cfgProfilesItems.get(settings)[name] as TestProfileSnapshot | undefined;
}

describe("profiles", () => {
	describe("captureCurrentSnapshot", () => {
		it("captures modelRoles and defaultThinkingLevel from live settings", async () => {
			const s = Settings.instance;
			cfgModelRoles.set(s, { default: "anthropic/claude-sonnet-4", smol: "anthropic/claude-haiku" });
			cfgDefaultThinkingLevel.set(s, Effort.High);

			const snapshot = captureCurrentSnapshot();
			expect(snapshot.modelRoles).toEqual({
				default: "anthropic/claude-sonnet-4",
				smol: "anthropic/claude-haiku",
			});
			expect(snapshot.defaultThinkingLevel).toBe("high");
		});

		it("round-trips an advisor role alongside default", () => {
			// Regression: profile snapshots must carry every configured model role,
			// including `advisor`, so a profile switch restores the advisor model
			// (drives the `applyProfileToSession` advisor rebuild). A prior version
			// captured only a subset of roles and silently dropped `advisor`.
			const s = Settings.instance;
			cfgModelRoles.set(s, {
				default: "anthropic/claude-sonnet-4",
				advisor: "anthropic/claude-haiku",
			});
			cfgDefaultThinkingLevel.set(s, Effort.High);

			const snapshot = captureCurrentSnapshot();
			expect(snapshot.modelRoles).toEqual({
				default: "anthropic/claude-sonnet-4",
				advisor: "anthropic/claude-haiku",
			});
			expect(snapshot.modelRoles.advisor).toBe("anthropic/claude-haiku");
			expect(snapshot.defaultThinkingLevel).toBe(Effort.High);
		});

		it("returns a copy, not a reference", () => {
			const s = Settings.instance;
			cfgModelRoles.set(s, { default: "a/b" });
			const snap = captureCurrentSnapshot();
			cfgModelRoles.set(s, { default: "x/y" });
			expect(snap.modelRoles.default).toBe("a/b");
		});
	});

	describe("addProfile", () => {
		it("creates a profile from current config", () => {
			const s = Settings.instance;
			cfgModelRoles.set(s, { default: "a/b" });
			cfgDefaultThinkingLevel.set(s, Effort.Medium);

			addProfile("work");

			const profiles = listProfiles();
			expect(profiles).toHaveLength(2); // auto-created "default" + "work"
			expect(profiles.find(p => p.name === "work")).toBeDefined();
			expect(profiles.find(p => p.name === "default")).toBeDefined();
			expect(getActiveProfileName()).toBe("work");
		});

		it("auto-creates default profile when adding first named profile", () => {
			addProfile("custom");

			const profiles = listProfiles();
			const defaultProfile = profiles.find(p => p.name === "default");
			const customProfile = profiles.find(p => p.name === "custom");
			expect(defaultProfile).toBeDefined();
			expect(customProfile).toBeDefined();
			// active should be the newly added one
			expect(getActiveProfileName()).toBe("custom");
		});

		it("does not auto-create default when adding 'default' itself", () => {
			addProfile("default");

			const profiles = listProfiles();
			expect(profiles).toHaveLength(1);
			expect(profiles[0].name).toBe("default");
		});

		it("throws on duplicate name", () => {
			addProfile("work");
			expect(() => addProfile("work")).toThrow('Profile "work" already exists');
		});

		it("accepts a custom snapshot", () => {
			const snap = { modelRoles: { default: "x/y" }, defaultThinkingLevel: "low" };
			addProfile("custom", snap);

			const profiles = listProfiles();
			const custom = profiles.find(p => p.name === "custom");
			expect(custom?.snapshot.modelRoles.default).toBe("x/y");
			expect(custom?.snapshot.defaultThinkingLevel).toBe("low");
		});
	});

	describe("switchProfile", () => {
		it("overwrites live settings from profile snapshot", () => {
			const s = Settings.instance;
			addProfile("first", { modelRoles: { default: "a/b" }, defaultThinkingLevel: Effort.High });
			addProfile("second", {
				modelRoles: { default: "x/y", smol: "x/z" },
				defaultThinkingLevel: Effort.Low,
			});

			switchProfile("first");

			expect(cfgModelRoles.get(s)).toEqual({ default: "a/b" });
			expect(cfgDefaultThinkingLevel.get(s)).toBe(Effort.High);
			expect(getActiveProfileName()).toBe("first");
		});

		it("writes modelRoles (incl. advisor role) and defaultThinkingLevel to live settings", () => {
			// Regression: `switchProfile` must restore every persisted model role
			// AND the profile's `defaultThinkingLevel`. If either is silently
			// dropped, the advisor keeps its previous model or the session ignores
			// the profile's configured thinking effort. Two profiles with distinct
			// advisor roles + distinct thinking levels prove the write is real
			// (not a happy-path no-op that reads the live value back).
			const s = Settings.instance;
			addProfile("with-haiku-advisor", {
				modelRoles: {
					default: "anthropic/claude-sonnet-4",
					advisor: "anthropic/claude-haiku",
				},
				defaultThinkingLevel: Effort.High,
			});
			addProfile("with-openai-advisor", {
				modelRoles: {
					default: "anthropic/claude-sonnet-4",
					advisor: "openai/gpt-4o-mini",
				},
				defaultThinkingLevel: Effort.Low,
			});

			switchProfile("with-haiku-advisor");
			expect(cfgModelRoles.get(s)).toEqual({
				default: "anthropic/claude-sonnet-4",
				advisor: "anthropic/claude-haiku",
			});
			expect(cfgModelRoles.get(s).advisor).toBe("anthropic/claude-haiku");
			expect(cfgDefaultThinkingLevel.get(s)).toBe(Effort.High);

			switchProfile("with-openai-advisor");
			expect(cfgModelRoles.get(s).advisor).toBe("openai/gpt-4o-mini");
			expect(cfgDefaultThinkingLevel.get(s)).toBe(Effort.Low);
		});

		it("throws for nonexistent profile", () => {
			expect(() => switchProfile("nope")).toThrow('Profile "nope" not found');
		});

		it("auto-saves current config back to the old profile before switching", () => {
			const s = Settings.instance;

			// Create two profiles
			addProfile("first", { modelRoles: { default: "a/original" }, defaultThinkingLevel: Effort.High });
			addProfile("second", { modelRoles: { default: "b/original" }, defaultThinkingLevel: Effort.Low });

			// Switch to first
			switchProfile("first");
			expect(cfgModelRoles.get(s)).toEqual({ default: "a/original" });

			// Manually change models while on "first"
			cfgModelRoles.set(s, { default: "a/modified" });
			cfgDefaultThinkingLevel.set(s, Effort.Medium);

			// Switch to second — should auto-save "first" with the modified values
			switchProfile("second");
			expect(cfgModelRoles.get(s)).toEqual({ default: "b/original" });

			// Switch back to first — should have the modifications we made
			switchProfile("first");
			expect(cfgModelRoles.get(s)).toEqual({ default: "a/modified" });
			expect(cfgDefaultThinkingLevel.get(s)).toBe(Effort.Medium);
		});
		it("preserves cross-provider changes on auto-save (gem-proxy regression)", () => {
			const s = Settings.instance;

			// Start with an anthropic-baselined profile (like user's gem-proxy).
			addProfile("gem-proxy", {
				modelRoles: { default: "anthropic/claude-opus-4-7:high" },
				defaultThinkingLevel: Effort.High,
			});
			addProfile("other", {
				modelRoles: { default: "anthropic/claude-sonnet" },
				defaultThinkingLevel: Effort.High,
			});

			switchProfile("gem-proxy");
			expect(cfgModelRoles.get(s).default).toBe("anthropic/claude-opus-4-7:high");

			// User deliberately swaps to a different provider entirely.
			s.setModelRole("default", "gemini-proxy/gemini-2.5-flash:high");

			// Swap away → auto-save gem-proxy → swap back. The cross-provider edit
			// must survive the round-trip. Pre-fix: the smart-merge discarded it.
			switchProfile("other");
			switchProfile("gem-proxy");
			expect(cfgModelRoles.get(s).default).toBe("gemini-proxy/gemini-2.5-flash:high");

			// The persisted snapshot also reflects the new provider.
			const gp = listProfiles().find(p => p.name === "gem-proxy");
			expect(gp?.snapshot.modelRoles.default).toBe("gemini-proxy/gemini-2.5-flash:high");
		});

		it("replaces stale runtime overrides when switching profiles", () => {
			const s = Settings.instance;
			cfgProfilesItems.set(s, {
				current: { modelRoles: { default: "provider/current" }, defaultThinkingLevel: "low" },
				target: { modelRoles: { default: "openai/gpt-target" }, defaultThinkingLevel: "high" },
			});
			cfgProfilesActive.set(s, "current");
			cfgModelRoles.override(s, { default: "google/gemini-stale" });
			cfgDefaultThinkingLevel.override(s, Effort.Low);

			switchProfile("target");

			expect(cfgModelRoles.get(s)).toEqual({ default: "openai/gpt-target" });
			expect(cfgDefaultThinkingLevel.get(s)).toBe(Effort.High);
		});

		it("does not overwrite live edits when re-selecting the active profile", () => {
			const s = Settings.instance;
			cfgModelRoles.set(s, { default: "anthropic/claude-opus-4-7:high" });
			addProfile("gem-proxy");

			// User is on gem-proxy, changes model.
			s.setModelRole("default", "gemini-proxy/gemini-2.5-flash:high");

			// Selecting the already-active profile must be a no-op (not a reset).
			switchProfile("gem-proxy");
			expect(cfgModelRoles.get(s).default).toBe("gemini-proxy/gemini-2.5-flash:high");
		});
	});

	describe("CommandController /profiles switch", () => {
		it("switches and reports only the session-local settings instance", async () => {
			const singleton = Settings.instance;
			cfgProfilesItems.set(singleton, {
				"singleton-current": {
					modelRoles: { default: "provider/singleton-current" },
					defaultThinkingLevel: Effort.Low,
				},
				"singleton-other": {
					modelRoles: { default: "provider/singleton-other" },
					defaultThinkingLevel: Effort.High,
				},
			});
			cfgProfilesActive.set(singleton, "singleton-current");
			cfgModelRoles.set(singleton, { default: "provider/singleton-live" });
			cfgDefaultThinkingLevel.set(singleton, Effort.Medium);

			const peer = Settings.isolated();
			cfgProfilesItems.set(peer, {
				"peer-current": {
					modelRoles: { default: "provider/peer-current" },
					defaultThinkingLevel: Effort.Low,
				},
				"peer-other": {
					modelRoles: { default: "provider/peer-other" },
					defaultThinkingLevel: Effort.High,
				},
			});
			cfgProfilesActive.set(peer, "peer-current");
			cfgModelRoles.set(peer, { default: "provider/peer-live" });
			cfgDefaultThinkingLevel.set(peer, Effort.Medium);

			const local = Settings.isolated();
			cfgProfilesItems.set(local, {
				"local-current": {
					modelRoles: { default: "provider/local-current" },
					defaultThinkingLevel: Effort.Low,
				},
				"local-target": {
					modelRoles: { default: "provider/local-target" },
					defaultThinkingLevel: Effort.XHigh,
				},
			});
			cfgProfilesActive.set(local, "local-current");
			cfgModelRoles.set(local, { default: "provider/local-live" });
			cfgDefaultThinkingLevel.set(local, Effort.Medium);

			const singletonBefore = {
				active: singleton.activeProfileName(),
				modelRoles: structuredClone(cfgModelRoles.get(singleton)),
				thinking: cfgDefaultThinkingLevel.get(singleton),
				items: structuredClone(cfgProfilesItems.get(singleton)),
			};
			const peerBefore = {
				active: peer.activeProfileName(),
				modelRoles: structuredClone(cfgModelRoles.get(peer)),
				thinking: cfgDefaultThinkingLevel.get(peer),
				items: structuredClone(cfgProfilesItems.get(peer)),
			};
			const bindSessionProfile = vi.fn(async () => true);
			const showStatus = vi.fn();
			const showError = vi.fn();
			const showWarning = vi.fn();
			const ctx = {
				settings: local,
				session: {
					bindSessionProfile,
					resolveRoleModel: vi.fn(() => ({ provider: "provider", id: "local-target" })),
				},
				statusLine: { invalidate: vi.fn() },
				updateEditorBorderColor: vi.fn(),
				showStatus,
				showError,
				showWarning,
			} as unknown as InteractiveModeContext;

			await new CommandController(ctx).handleProfilesCommand("switch local-target");

			expect(local.activeProfileName()).toBe("local-target");
			expect(cfgModelRoles.get(local)).toEqual({ default: "provider/local-target" });
			expect(cfgDefaultThinkingLevel.get(local)).toBe(Effort.XHigh);
			expect(bindSessionProfile).toHaveBeenCalledTimes(1);
			expect(bindSessionProfile).toHaveBeenCalledWith("local-target");
			expect(showStatus).toHaveBeenCalledWith('Switched to profile "local-target".');
			expect(showError).not.toHaveBeenCalled();
			expect(showWarning).not.toHaveBeenCalled();
			expect({
				active: singleton.activeProfileName(),
				modelRoles: cfgModelRoles.get(singleton),
				thinking: cfgDefaultThinkingLevel.get(singleton),
				items: cfgProfilesItems.get(singleton),
			}).toEqual(singletonBefore);
			expect({
				active: peer.activeProfileName(),
				modelRoles: cfgModelRoles.get(peer),
				thinking: cfgDefaultThinkingLevel.get(peer),
				items: cfgProfilesItems.get(peer),
			}).toEqual(peerBefore);
		});
	});

	describe("deleteProfile", () => {
		it("removes an inactive profile without changing the selected profile or live model", () => {
			const s = Settings.instance;
			cfgProfilesItems.set(s, {
				active: { modelRoles: { default: "provider/active" }, defaultThinkingLevel: "high" },
				drop: { modelRoles: { default: "provider/drop" }, defaultThinkingLevel: "low" },
			});
			cfgProfilesActive.set(s, "active");
			cfgModelRoles.set(s, { default: "provider/active" });

			const result = deleteProfile("drop");

			expect(result.activated).toBeUndefined();
			expect(getActiveProfileName()).toBe("active");
			expect(cfgModelRoles.get(s).default).toBe("provider/active");
			expect(listProfiles().map(profile => profile.name)).toEqual(["active"]);
		});

		it("deleting the selected profile keeps the terminal pinned to it", () => {
			const s = Settings.instance;
			cfgProfilesItems.set(s, {
				selected: { modelRoles: { default: "provider/selected" }, defaultThinkingLevel: "high" },
				zeta: { modelRoles: { default: "provider/zeta" }, defaultThinkingLevel: "low" },
				alpha: { modelRoles: { default: "provider/alpha" }, defaultThinkingLevel: "medium" },
			});
			cfgProfilesActive.set(s, "selected");
			cfgModelRoles.set(s, { default: "provider/selected" });
			cfgDefaultThinkingLevel.set(s, Effort.High);

			const result = deleteProfile("selected");

			expect(result.activated).toBeUndefined();
			expect(getActiveProfileName()).toBe("selected");
			expect(cfgModelRoles.get(s)).toEqual({ default: "provider/selected" });
			expect(cfgDefaultThinkingLevel.get(s)).toBe(Effort.High);
		});

		it("deleting the selected profile preserves explicit runtime overrides", () => {
			const s = Settings.instance;
			cfgProfilesItems.set(s, {
				selected: { modelRoles: { default: "provider/selected" }, defaultThinkingLevel: "low" },
				fallback: { modelRoles: { default: "openai/gpt-fallback" }, defaultThinkingLevel: "high" },
			});
			cfgProfilesActive.set(s, "selected");
			cfgModelRoles.override(s, { default: "google/gemini-stale" });

			const result = deleteProfile("selected");

			expect(result.activated).toBeUndefined();
			expect(getActiveProfileName()).toBe("selected");
			expect(cfgModelRoles.get(s)).toEqual({ default: "google/gemini-stale" });
		});

		it("deleting the selected profile never chooses a valid or malformed sibling", () => {
			const s = Settings.instance;
			cfgProfilesItems.set(s, {
				selected: { modelRoles: { default: "provider/selected" }, defaultThinkingLevel: "high" },
				aBroken: { modelRoles: { default: 42 }, defaultThinkingLevel: "low" },
				valid: { modelRoles: { default: "provider/valid" }, defaultThinkingLevel: "low" },
			});
			cfgProfilesActive.set(s, "selected");
			cfgModelRoles.set(s, { default: "provider/selected" });

			const result = deleteProfile("selected");

			expect(result.activated).toBeUndefined();
			expect(getActiveProfileName()).toBe("selected");
			expect(cfgModelRoles.get(s).default).toBe("provider/selected");
		});

		it("deleting the only profile keeps its identity and live settings", () => {
			const s = Settings.instance;
			cfgProfilesItems.set(s, {
				only: { modelRoles: { default: "provider/saved" }, defaultThinkingLevel: "low" },
			});
			cfgProfilesActive.set(s, "only");
			cfgModelRoles.set(s, { default: "provider/live-edit" });
			cfgDefaultThinkingLevel.set(s, Effort.High);

			const result = deleteProfile("only");

			expect(result.activated).toBeUndefined();
			expect(getActiveProfileName()).toBe("only");
			expect(cfgModelRoles.get(s).default).toBe("provider/live-edit");
			expect(cfgDefaultThinkingLevel.get(s)).toBe(Effort.High);
		});

		it("deleting a malformed selected profile preserves its identity", () => {
			const s = Settings.instance;
			cfgProfilesItems.set(s, {
				broken: { garbage: true },
				valid: { modelRoles: { default: "provider/valid" }, defaultThinkingLevel: "high" },
			});
			cfgProfilesActive.set(s, "broken");

			const result = deleteProfile("broken");

			expect(result.activated).toBeUndefined();
			expect(getActiveProfileName()).toBe("broken");
		});

		it("preserves a stale active marker while deleting another profile", () => {
			const s = Settings.instance;
			cfgProfilesItems.set(s, {
				drop: { modelRoles: { default: "provider/drop" }, defaultThinkingLevel: "high" },
				keep: { modelRoles: { default: "provider/keep" }, defaultThinkingLevel: "high" },
			});
			cfgProfilesActive.set(s, "missing");

			deleteProfile("drop");

			expect(cfgProfilesActive.get(s)).toBe("missing");
			expect(getActiveProfileName()).toBe("missing");
		});

		it("throws for nonexistent profile without changing state", () => {
			const s = Settings.instance;
			cfgProfilesItems.set(s, {
				keep: { modelRoles: { default: "provider/keep" }, defaultThinkingLevel: "high" },
			});
			cfgProfilesActive.set(s, "keep");
			expect(() => deleteProfile("nope")).toThrow('Profile "nope" not found');
			expect(getActiveProfileName()).toBe("keep");
			expect(listProfiles()).toHaveLength(1);
		});
	});

	describe("renameProfile", () => {
		it("renames a profile preserving snapshot", () => {
			const s = Settings.instance;
			cfgModelRoles.set(s, { default: "a/b" });
			addProfile("old");

			renameProfile("old", "new");

			const profiles = listProfiles();
			expect(profiles.find(p => p.name === "old")).toBeUndefined();
			const renamed = profiles.find(p => p.name === "new");
			expect(renamed).toBeDefined();
			expect(renamed?.snapshot.modelRoles.default).toBe("a/b");
		});

		it("updates active name when renaming the active profile", () => {
			addProfile("active-one");
			expect(getActiveProfileName()).toBe("active-one");
			renameProfile("active-one", "renamed");
			expect(getActiveProfileName()).toBe("renamed");
		});

		it("throws for nonexistent source", () => {
			expect(() => renameProfile("nope", "new")).toThrow('Profile "nope" not found');
		});

		it("throws for duplicate target", () => {
			addProfile("a");
			addProfile("b");
			expect(() => renameProfile("a", "b")).toThrow('Profile "b" already exists');
		});
	});

	describe("saveActiveProfile", () => {
		it("re-captures current settings into the active profile", () => {
			const s = Settings.instance;
			cfgModelRoles.set(s, { default: "a/original" });
			cfgDefaultThinkingLevel.set(s, Effort.High);
			addProfile("work");

			// Change settings
			cfgModelRoles.set(s, { default: "a/modified" });
			cfgDefaultThinkingLevel.set(s, Effort.Low);

			saveActiveProfile();

			// Verify the profile was updated
			const profiles = listProfiles();
			const work = profiles.find(p => p.name === "work");
			expect(work?.snapshot.modelRoles.default).toBe("a/modified");
			expect(work?.snapshot.defaultThinkingLevel).toBe("low");
		});

		it("throws when no active profile", () => {
			expect(() => saveActiveProfile()).toThrow("No active profile to save");
		});
	});

	describe("cycleProfile", () => {
		it("returns undefined with fewer than 2 profiles", () => {
			expect(cycleProfile()).toBeUndefined();

			addProfile("only");
			// "only" + auto-created "default" = 2 profiles, so cycle should work
			const result = cycleProfile();
			expect(result).toBeDefined();
		});

		it("cycles through profiles alphabetically", () => {
			const s = Settings.instance;
			cfgModelRoles.set(s, { default: "a/a" });
			addProfile("alpha");
			cfgModelRoles.set(s, { default: "b/b" });
			addProfile("beta");

			// Active is "beta" (last added). Sorted order: alpha, beta, default
			// Cycle from beta -> default
			const r1 = cycleProfile();
			expect(r1?.name).toBe("default");

			// Cycle from default -> alpha
			const r2 = cycleProfile();
			expect(r2?.name).toBe("alpha");

			// Cycle from alpha -> beta
			const r3 = cycleProfile();
			expect(r3?.name).toBe("beta");

			// Wraps: beta -> default
			const r4 = cycleProfile();
			expect(r4?.name).toBe("default");
		});

		it("applies the profile settings when cycling", () => {
			const s = Settings.instance;
			cfgModelRoles.set(s, { default: "provider/model-a" });
			cfgDefaultThinkingLevel.set(s, Effort.High);
			addProfile("a");

			cfgModelRoles.set(s, { default: "provider/model-b" });
			cfgDefaultThinkingLevel.set(s, Effort.Low);
			addProfile("b");

			// cycle away from "b" — should land on one of the other profiles
			const result = cycleProfile();
			expect(result).toBeDefined();

			// live settings should match the profile we cycled to
			const expected = result!.snapshot;
			expect(cfgModelRoles.get(s)).toEqual(expected.modelRoles);
			expect(cfgDefaultThinkingLevel.get(s)).toBe(expected.defaultThinkingLevel as Effort);
		});

		it("auto-saves before cycling away", () => {
			const s = Settings.instance;
			cfgModelRoles.set(s, { default: "a/orig" });
			addProfile("a");
			cfgModelRoles.set(s, { default: "b/orig" });
			addProfile("b");

			// Active is "b". Modify settings while on "b"
			cfgModelRoles.set(s, { default: "b/modified" });

			// Cycle away from "b"
			cycleProfile();

			// Cycle back to "b" — should have the modified value
			// Need to cycle enough times to get back
			let found = false;
			for (let i = 0; i < 5; i++) {
				const r = cycleProfile();
				if (r?.name === "b") {
					expect(cfgModelRoles.get(s)).toEqual({ default: "b/modified" });
					found = true;
					break;
				}
			}
			expect(found).toBe(true);
		});
	});

	describe("ensureDefaultProfile", () => {
		it("creates default profile when none exist", () => {
			ensureDefaultProfile();
			const profiles = listProfiles();
			expect(profiles).toHaveLength(1);
			expect(profiles[0].name).toBe("default");
		});

		it("no-ops when profiles already exist", () => {
			addProfile("existing");
			ensureDefaultProfile();
			const profiles = listProfiles();
			// Should have "existing" + auto-created "default" but not a second default
			const defaultCount = profiles.filter(p => p.name === "default").length;
			expect(defaultCount).toBe(1);
		});
	});

	describe("listProfiles", () => {
		it("returns sorted profiles with active indicator", () => {
			addProfile("zebra");
			addProfile("alpha");

			const profiles = listProfiles();
			expect(profiles[0].name).toBe("alpha");
			expect(profiles[profiles.length - 1].name).toBe("zebra");

			const active = profiles.find(p => p.isActive);
			expect(active?.name).toBe("alpha"); // last added is active
		});

		it("skips invalid entries", () => {
			const s = Settings.instance;
			cfgProfilesItems.set(s, {
				valid: { modelRoles: { default: "a/b" }, defaultThinkingLevel: "high" },
				invalid: { garbage: true },
				alsoInvalid: "string",
			});

			const profiles = listProfiles();
			expect(profiles).toHaveLength(1);
			expect(profiles[0].name).toBe("valid");
		});
	});

	describe("profile state invariants", () => {
		it("preserves an active marker pointing to a missing profile", () => {
			const s = Settings.instance;
			cfgProfilesActive.set(s, "ghost");
			expect(getActiveProfileName()).toBe("ghost");
			expect(listProfiles().some(profile => profile.isActive)).toBe(false);
		});

		it("preserves an active marker pointing to a malformed profile", () => {
			const s = Settings.instance;
			cfgProfilesItems.set(s, { broken: { modelRoles: { default: 7 }, defaultThinkingLevel: "high" } });
			cfgProfilesActive.set(s, "broken");
			expect(getActiveProfileName()).toBe("broken");
			expect(listProfiles()).toEqual([]);
		});

		it("cycles only across valid profiles and ignores malformed keys", () => {
			const s = Settings.instance;
			cfgProfilesItems.set(s, {
				alpha: { modelRoles: { default: "provider/a" }, defaultThinkingLevel: "high" },
				broken: { modelRoles: { default: false }, defaultThinkingLevel: "low" },
				zeta: { modelRoles: { default: "provider/z" }, defaultThinkingLevel: "low" },
			});
			cfgProfilesActive.set(s, "alpha");
			const result = cycleProfile();
			expect(result?.name).toBe("zeta");
			expect(cfgModelRoles.get(s).default).toBe("provider/z");
		});

		it("returns undefined when only one valid profile remains beside malformed keys", () => {
			const s = Settings.instance;
			cfgProfilesItems.set(s, {
				valid: { modelRoles: { default: "provider/valid" }, defaultThinkingLevel: "high" },
				broken: "not-a-snapshot",
			});
			cfgProfilesActive.set(s, "valid");
			expect(cycleProfile()).toBeUndefined();
			expect(getActiveProfileName()).toBe("valid");
		});

		it("restores profile name, roles, and thinking after a failed runtime apply", () => {
			const s = Settings.instance;
			cfgProfilesItems.set(s, {
				one: { modelRoles: { default: "provider/one" }, defaultThinkingLevel: "high" },
				two: { modelRoles: { default: "provider/two" }, defaultThinkingLevel: "low" },
			});
			cfgProfilesActive.set(s, "one");
			cfgModelRoles.set(s, { default: "provider/live-one" });
			cfgDefaultThinkingLevel.set(s, Effort.XHigh);
			const before = captureProfileActivationState();

			switchProfile("two");
			restoreProfileActivation(before);

			expect(getActiveProfileName()).toBe("one");
			expect(cfgModelRoles.get(s)).toEqual({ default: "provider/live-one" });
			expect(cfgDefaultThinkingLevel.get(s)).toBe(Effort.XHigh);

			// Rollback must retag ownership synchronously: an immediate edit belongs
			// to restored profile one, never failed target two.
			cfgDefaultThinkingLevel.set(s, Effort.Medium);
			expect(profileSnapshot(s, "one")?.defaultThinkingLevel).toBe(Effort.Medium);
			expect(profileSnapshot(s, "two")?.defaultThinkingLevel).toBe("low");
		});

		it("clears failed target ownership when rolling back to no active profile", () => {
			const s = Settings.instance;
			cfgModelRoles.set(s, { default: "provider/base" });
			cfgDefaultThinkingLevel.set(s, Effort.High);
			s.setProfileItem("target", {
				modelRoles: { default: "provider/target" },
				defaultThinkingLevel: Effort.Low,
			});
			const before = captureProfileActivationState();

			switchProfile("target");
			restoreProfileActivation(before);
			cfgDefaultThinkingLevel.set(s, Effort.Medium);

			expect(getActiveProfileName()).toBeUndefined();
			expect(profileSnapshot(s, "target")?.defaultThinkingLevel).toBe(Effort.Low);
			expect(cfgDefaultThinkingLevel.get(s)).toBe(Effort.Medium);
		});

		it("attributes immediate edits to newly added and actively renamed profiles", () => {
			const s = Settings.instance;
			cfgModelRoles.set(s, { default: "provider/base" });
			cfgDefaultThinkingLevel.set(s, Effort.High);
			addProfile("added");
			cfgDefaultThinkingLevel.set(s, Effort.Medium);
			expect(profileSnapshot(s, "added")?.defaultThinkingLevel).toBe(Effort.Medium);

			renameProfile("added", "renamed");
			cfgDefaultThinkingLevel.set(s, Effort.Low);
			expect(profileSnapshot(s, "renamed")?.defaultThinkingLevel).toBe(Effort.Low);
			expect(cfgProfilesItems.get(s)).not.toHaveProperty("added");
		});
	});

	describe("full pipeline: create, modify, switch, cycle, save", () => {
		it("preserves changes across profile switches", () => {
			const s = Settings.instance;

			// Step 1: Create distinct saved profiles explicitly.
			addProfile("work", {
				modelRoles: { default: "anthropic/claude-sonnet-4", smol: "anthropic/claude-haiku" },
				defaultThinkingLevel: Effort.High,
			});

			// Step 2: Create the distinct "personal" profile.
			addProfile("personal", {
				modelRoles: { default: "ollama/llama3" },
				defaultThinkingLevel: Effort.Medium,
			});

			// Step 3: Switch to "work"
			switchProfile("work");
			expect(cfgModelRoles.get(s)).toEqual({
				default: "anthropic/claude-sonnet-4",
				smol: "anthropic/claude-haiku",
			});
			expect(cfgDefaultThinkingLevel.get(s)).toBe(Effort.High);

			// Step 4: Modify models while on "work"
			cfgModelRoles.set(s, {
				default: "anthropic/claude-sonnet-4",
				smol: "anthropic/claude-haiku",
				slow: "anthropic/claude-opus",
			});

			// Step 5: Switch to "personal" — "work" changes should be auto-saved
			switchProfile("personal");
			expect(cfgModelRoles.get(s)).toEqual({ default: "ollama/llama3" });
			expect(cfgDefaultThinkingLevel.get(s)).toBe(Effort.Medium);

			// Step 6: Switch back to "work" — should see the added "slow" role
			switchProfile("work");
			expect(cfgModelRoles.get(s)).toEqual({
				default: "anthropic/claude-sonnet-4",
				smol: "anthropic/claude-haiku",
				slow: "anthropic/claude-opus",
			});

			// Step 7: Cycle through profiles — each switch should auto-save
			cfgDefaultThinkingLevel.set(s, Effort.XHigh); // modify while on work
			cycleProfile(); // cycle away from work
			// cycle back to work
			let result = cycleProfile();
			while (result?.name !== "work") {
				result = cycleProfile();
			}
			expect(cfgDefaultThinkingLevel.get(s)).toBe(Effort.XHigh);

			// Step 8: Explicit save
			cfgModelRoles.set(s, { default: "final/model" });
			saveActiveProfile();
			const workProfile = listProfiles().find(p => p.name === "work");
			expect(workProfile?.snapshot.modelRoles.default).toBe("final/model");
		});
	});
});
