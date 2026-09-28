import { type Settings, settings } from "./settings";
import { cfgDefaultThinkingLevel } from "../session/settings";
import { cfgModelRoles } from "./model-settings";
import { cfgProfilesActive, cfgProfilesItems } from "./profile-settings";
import type { SettingValueOf } from "./registry";

export { cfgProfilesActive, cfgProfilesItems } from "./profile-settings";

export interface ProfileSnapshot {
	modelRoles: Record<string, string>;
	defaultThinkingLevel: string;
}

export interface ProfileInfo {
	name: string;
	isActive: boolean;
	snapshot: ProfileSnapshot;
}

export interface ProfileDeleteResult {
	deletedName: string;
	activated?: ProfileCycleResult;
}

export interface ProfileActivationState {
	name?: string;
	snapshot: ProfileSnapshot;
}

export interface ProfileCycleResult {
	name: string;
	snapshot: ProfileSnapshot;
}

/** Validate and copy a raw object to ProfileSnapshot, returning undefined if invalid. */
function asSnapshot(raw: unknown): ProfileSnapshot | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const obj = raw as Record<string, unknown>;
	if (typeof obj.defaultThinkingLevel !== "string") return undefined;
	if (typeof obj.modelRoles !== "object" || obj.modelRoles === null || Array.isArray(obj.modelRoles)) return undefined;
	const modelRoles = obj.modelRoles as Record<string, unknown>;
	if (!Object.values(modelRoles).every(value => typeof value === "string")) return undefined;
	return {
		modelRoles: { ...modelRoles } as Record<string, string>,
		defaultThinkingLevel: obj.defaultThinkingLevel,
	};
}

/** Capture the current live config as a profile snapshot. */
export function captureCurrentSnapshot(source: Settings = settings): ProfileSnapshot {
	const modelRoles = cfgModelRoles.get(source);
	const defaultThinkingLevel = cfgDefaultThinkingLevel.get(source);
	return {
		modelRoles: { ...modelRoles },
		defaultThinkingLevel,
	};
}

/** List all saved profiles with their active status and snapshot. */
export function listProfiles(source: Settings = settings): ProfileInfo[] {
	const items = cfgProfilesItems.get(source);
	const active = getActiveProfileName(source);
	const result: ProfileInfo[] = [];
	for (const [name, raw] of Object.entries(items)) {
		const snapshot = asSnapshot(raw);
		if (!snapshot) continue;
		result.push({ name, isActive: name === active, snapshot });
	}
	result.sort((a, b) => a.name.localeCompare(b.name));
	return result;
}

/** Get this terminal's selected profile name, even when its saved definition disappeared. */
export function getActiveProfileName(source: Settings = settings): string | undefined {
	const active = cfgProfilesActive.get(source);
	return active || undefined;
}

/** Capture enough live state to roll back a failed session-level profile apply. */
export function captureProfileActivationState(source: Settings = settings): ProfileActivationState {
	return { name: getActiveProfileName(source), snapshot: captureCurrentSnapshot(source) };
}

/** Restore live profile settings after a failed session-level apply. */
export function restoreProfileActivation(state: ProfileActivationState, source: Settings = settings): void {
	source.restoreProfileActivation(state.name, state.snapshot);
}

/**
 * Add a new profile. If no profiles exist yet, auto-captures "default" first.
 * Sets the new profile as active.
 * Throws if the name already exists.
 */
export function addProfile(name: string, snapshot?: ProfileSnapshot, source: Settings = settings): void {
	const items = cfgProfilesItems.get(source);

	if (name in items) {
		throw new Error(`Profile "${name}" already exists`);
	}

	// Auto-create "default" from current config if no profiles exist
	if (Object.keys(items).length === 0 && name !== "default") {
		source.setProfileItem("default", captureCurrentSnapshot(source));
	}

	const nextSnapshot = snapshot ?? captureCurrentSnapshot(source);
	source.setProfileItem(name, nextSnapshot);
	source.activateProfile(name, nextSnapshot);
}

/**
 * Switch to an existing profile, overwriting live modelRoles and defaultThinkingLevel.
 * Throws if profile not found.
 */
export function switchProfile(name: string, source: Settings = settings): void {
	const items = cfgProfilesItems.get(source);
	const snapshot = asSnapshot(items[name]);
	if (!snapshot) {
		throw new Error(`Profile "${name}" not found`);
	}

	const active = getActiveProfileName(source);

	// No-op when re-selecting the already-active profile. Reapplying the
	// stored snapshot here would wipe live edits the user has made but not
	// yet explicitly saved (e.g. model selector changes). Users can force a
	// reset via `/profiles switch <other>` then back if they want that.
	if (active === name) {
		return;
	}

	// Persisted live edits already update the active profile as granular
	// thinking/per-role deltas. Do not replace its whole potentially stale
	// snapshot here; explicit runtime overrides remain terminal-local.
	source.activateProfile(name, snapshot);
}

/** Delete a saved definition without changing any running terminal's selected identity. */
export function deleteProfile(name: string, source: Settings = settings): ProfileDeleteResult {
	const items = cfgProfilesItems.get(source);
	if (!(name in items)) {
		throw new Error(`Profile "${name}" not found`);
	}

	source.deleteProfileItem(name);
	return { deletedName: name };
}

/** Rename a profile. Throws if old not found or new already exists. */
export function renameProfile(oldName: string, newName: string, source: Settings = settings): void {
	const items = cfgProfilesItems.get(source);
	if (!(oldName in items)) {
		throw new Error(`Profile "${oldName}" not found`);
	}
	if (newName in items) {
		throw new Error(`Profile "${newName}" already exists`);
	}

	const wasActive = cfgProfilesActive.get(source) === oldName;
	const snapshot = asSnapshot(items[oldName]);
	if (!snapshot) {
		throw new Error(`Profile "${oldName}" is malformed`);
	}
	source.renameProfileItem(oldName, newName, snapshot, wasActive);
}

/** Re-capture the current live config into the selected profile; throws when none is selected. */
export function saveActiveProfile(source: Settings = settings): void {
	const active = getActiveProfileName(source);
	if (!active) {
		throw new Error("No active profile to save");
	}

	const snapshot = captureCurrentSnapshot(source);
	cfgModelRoles.set(source, snapshot.modelRoles);
	cfgDefaultThinkingLevel.set(source, snapshot.defaultThinkingLevel as SettingValueOf<typeof cfgDefaultThinkingLevel>);
}

/**
 * Cycle to the next profile (sorted alphabetically, wrapping).
 * Returns the profile switched to, or undefined if fewer than 2 profiles exist.
 */
export function cycleProfile(source: Settings = settings): ProfileCycleResult | undefined {
	const profiles = listProfiles(source);
	if (profiles.length < 2) return undefined;

	const active = getActiveProfileName(source);
	const currentIndex = active ? profiles.findIndex(profile => profile.name === active) : -1;
	const next = profiles[(currentIndex + 1) % profiles.length];
	switchProfile(next.name, source);
	return { name: next.name, snapshot: next.snapshot };
}

/** Auto-create a "default" profile from current config if no profiles exist. */
export function ensureDefaultProfile(source: Settings = settings): void {
	const items = cfgProfilesItems.get(source);
	if (Object.keys(items).length === 0) {
		addProfile("default", undefined, source);
	}
}
