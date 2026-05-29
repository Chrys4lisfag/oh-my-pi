import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import {
	addProfile,
	captureCurrentSnapshot,
	cycleProfile,
	deleteProfile,
	ensureDefaultProfile,
	getActiveProfileName,
	listProfiles,
	renameProfile,
	saveActiveProfile,
	switchProfile,
} from "@oh-my-pi/pi-coding-agent/config/profiles";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
});

describe("profiles", () => {
	describe("captureCurrentSnapshot", () => {
		it("captures modelRoles and defaultThinkingLevel from live settings", async () => {
			const s = Settings.instance;
			s.set("modelRoles", { default: "anthropic/claude-sonnet-4", smol: "anthropic/claude-haiku" });
			s.set("defaultThinkingLevel", Effort.High);

			const snapshot = captureCurrentSnapshot();
			expect(snapshot.modelRoles).toEqual({
				default: "anthropic/claude-sonnet-4",
				smol: "anthropic/claude-haiku",
			});
			expect(snapshot.defaultThinkingLevel).toBe("high");
		});

		it("returns a copy, not a reference", () => {
			const s = Settings.instance;
			s.set("modelRoles", { default: "a/b" });
			const snap = captureCurrentSnapshot();
			s.set("modelRoles", { default: "x/y" });
			expect(snap.modelRoles.default).toBe("a/b");
		});
	});

	describe("addProfile", () => {
		it("creates a profile from current config", () => {
			const s = Settings.instance;
			s.set("modelRoles", { default: "a/b" });
			s.set("defaultThinkingLevel", Effort.Medium);

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
			s.set("modelRoles", { default: "a/b" });
			s.set("defaultThinkingLevel", Effort.High);
			addProfile("first");

			s.set("modelRoles", { default: "x/y", smol: "x/z" });
			s.set("defaultThinkingLevel", Effort.Low);
			addProfile("second");

			switchProfile("first");

			expect(s.get("modelRoles")).toEqual({ default: "a/b" });
			expect(s.get("defaultThinkingLevel")).toBe(Effort.High);
			expect(getActiveProfileName()).toBe("first");
		});

		it("throws for nonexistent profile", () => {
			expect(() => switchProfile("nope")).toThrow('Profile "nope" not found');
		});

		it("auto-saves current config back to the old profile before switching", () => {
			const s = Settings.instance;

			// Create two profiles
			s.set("modelRoles", { default: "a/original" });
			s.set("defaultThinkingLevel", Effort.High);
			addProfile("first");

			s.set("modelRoles", { default: "b/original" });
			s.set("defaultThinkingLevel", Effort.Low);
			addProfile("second");

			// Switch to first
			switchProfile("first");
			expect(s.get("modelRoles")).toEqual({ default: "a/original" });

			// Manually change models while on "first"
			s.set("modelRoles", { default: "a/modified" });
			s.set("defaultThinkingLevel", Effort.Medium);

			// Switch to second — should auto-save "first" with the modified values
			switchProfile("second");
			expect(s.get("modelRoles")).toEqual({ default: "b/original" });

			// Switch back to first — should have the modifications we made
			switchProfile("first");
			expect(s.get("modelRoles")).toEqual({ default: "a/modified" });
			expect(s.get("defaultThinkingLevel")).toBe(Effort.Medium);
		});
		it("preserves cross-provider changes on auto-save (gem-proxy regression)", () => {
			const s = Settings.instance;

			// Start with an anthropic-baselined profile (like user's gem-proxy).
			s.set("modelRoles", { default: "anthropic/claude-opus-4-7:high" });
			addProfile("gem-proxy");

			s.set("modelRoles", { default: "anthropic/claude-sonnet" });
			addProfile("other");

			switchProfile("gem-proxy");
			expect(s.get("modelRoles").default).toBe("anthropic/claude-opus-4-7:high");

			// User deliberately swaps to a different provider entirely.
			s.setModelRole("default", "gemini-proxy/gemini-2.5-flash:high");

			// Swap away → auto-save gem-proxy → swap back. The cross-provider edit
			// must survive the round-trip. Pre-fix: the smart-merge discarded it.
			switchProfile("other");
			switchProfile("gem-proxy");
			expect(s.get("modelRoles").default).toBe("gemini-proxy/gemini-2.5-flash:high");

			// The persisted snapshot also reflects the new provider.
			const gp = listProfiles().find(p => p.name === "gem-proxy");
			expect(gp?.snapshot.modelRoles.default).toBe("gemini-proxy/gemini-2.5-flash:high");
		});

		it("does not overwrite live edits when re-selecting the active profile", () => {
			const s = Settings.instance;
			s.set("modelRoles", { default: "anthropic/claude-opus-4-7:high" });
			addProfile("gem-proxy");

			// User is on gem-proxy, changes model.
			s.setModelRole("default", "gemini-proxy/gemini-2.5-flash:high");

			// Selecting the already-active profile must be a no-op (not a reset).
			switchProfile("gem-proxy");
			expect(s.get("modelRoles").default).toBe("gemini-proxy/gemini-2.5-flash:high");
		});
	});

	describe("deleteProfile", () => {
		it("removes a profile", () => {
			addProfile("a");
			addProfile("b");
			deleteProfile("a");

			const names = listProfiles().map(p => p.name);
			expect(names).not.toContain("a");
		});

		it("clears active if deleting the active profile", () => {
			addProfile("only");
			expect(getActiveProfileName()).toBe("only");
			deleteProfile("only");
			expect(getActiveProfileName()).toBeUndefined();
		});

		it("throws for nonexistent profile", () => {
			expect(() => deleteProfile("nope")).toThrow('Profile "nope" not found');
		});
	});

	describe("renameProfile", () => {
		it("renames a profile preserving snapshot", () => {
			const s = Settings.instance;
			s.set("modelRoles", { default: "a/b" });
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
			s.set("modelRoles", { default: "a/original" });
			s.set("defaultThinkingLevel", Effort.High);
			addProfile("work");

			// Change settings
			s.set("modelRoles", { default: "a/modified" });
			s.set("defaultThinkingLevel", Effort.Low);

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
			s.set("modelRoles", { default: "a/a" });
			addProfile("alpha");
			s.set("modelRoles", { default: "b/b" });
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
			s.set("modelRoles", { default: "provider/model-a" });
			s.set("defaultThinkingLevel", Effort.High);
			addProfile("a");

			s.set("modelRoles", { default: "provider/model-b" });
			s.set("defaultThinkingLevel", Effort.Low);
			addProfile("b");

			// cycle away from "b" — should land on one of the other profiles
			const result = cycleProfile();
			expect(result).toBeDefined();

			// live settings should match the profile we cycled to
			const expected = result!.snapshot;
			expect(s.get("modelRoles")).toEqual(expected.modelRoles);
			expect(s.get("defaultThinkingLevel")).toBe(expected.defaultThinkingLevel as Effort);
		});

		it("auto-saves before cycling away", () => {
			const s = Settings.instance;
			s.set("modelRoles", { default: "a/orig" });
			addProfile("a");
			s.set("modelRoles", { default: "b/orig" });
			addProfile("b");

			// Active is "b". Modify settings while on "b"
			s.set("modelRoles", { default: "b/modified" });

			// Cycle away from "b"
			cycleProfile();

			// Cycle back to "b" — should have the modified value
			// Need to cycle enough times to get back
			let found = false;
			for (let i = 0; i < 5; i++) {
				const r = cycleProfile();
				if (r?.name === "b") {
					expect(s.get("modelRoles")).toEqual({ default: "b/modified" });
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
			s.set("profiles.items", {
				valid: { modelRoles: { default: "a/b" }, defaultThinkingLevel: "high" },
				invalid: { garbage: true },
				alsoInvalid: "string",
			});

			const profiles = listProfiles();
			expect(profiles).toHaveLength(1);
			expect(profiles[0].name).toBe("valid");
		});
	});

	describe("full pipeline: create, modify, switch, cycle, save", () => {
		it("preserves changes across profile switches", () => {
			const s = Settings.instance;

			// Step 1: Set up initial config and create "work" profile
			s.set("modelRoles", { default: "anthropic/claude-sonnet-4", smol: "anthropic/claude-haiku" });
			s.set("defaultThinkingLevel", Effort.High);
			addProfile("work");

			// Step 2: Change to different models and create "personal" profile
			s.set("modelRoles", { default: "ollama/llama3" });
			s.set("defaultThinkingLevel", Effort.Medium);
			addProfile("personal");

			// Step 3: Switch to "work"
			switchProfile("work");
			expect(s.get("modelRoles")).toEqual({
				default: "anthropic/claude-sonnet-4",
				smol: "anthropic/claude-haiku",
			});
			expect(s.get("defaultThinkingLevel")).toBe(Effort.High);

			// Step 4: Modify models while on "work"
			s.set("modelRoles", {
				default: "anthropic/claude-sonnet-4",
				smol: "anthropic/claude-haiku",
				slow: "anthropic/claude-opus",
			});

			// Step 5: Switch to "personal" — "work" changes should be auto-saved
			switchProfile("personal");
			expect(s.get("modelRoles")).toEqual({ default: "ollama/llama3" });
			expect(s.get("defaultThinkingLevel")).toBe(Effort.Medium);

			// Step 6: Switch back to "work" — should see the added "slow" role
			switchProfile("work");
			expect(s.get("modelRoles")).toEqual({
				default: "anthropic/claude-sonnet-4",
				smol: "anthropic/claude-haiku",
				slow: "anthropic/claude-opus",
			});

			// Step 7: Cycle through profiles — each switch should auto-save
			s.set("defaultThinkingLevel", Effort.XHigh); // modify while on work
			cycleProfile(); // cycle away from work
			// cycle back to work
			let result = cycleProfile();
			while (result?.name !== "work") {
				result = cycleProfile();
			}
			expect(s.get("defaultThinkingLevel")).toBe(Effort.XHigh);

			// Step 8: Explicit save
			s.set("modelRoles", { default: "final/model" });
			saveActiveProfile();
			const workProfile = listProfiles().find(p => p.name === "work");
			expect(workProfile?.snapshot.modelRoles.default).toBe("final/model");
		});
	});
});
