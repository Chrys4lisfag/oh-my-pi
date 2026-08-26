import { settings } from "./settings";
import type { SettingValue } from "./settings-schema";

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
export function captureCurrentSnapshot(): ProfileSnapshot {
	const modelRoles = settings.get("modelRoles");
	const defaultThinkingLevel = settings.get("defaultThinkingLevel");
	return {
		modelRoles: { ...modelRoles },
		defaultThinkingLevel,
	};
}

/** List all saved profiles with their active status and snapshot. */
export function listProfiles(): ProfileInfo[] {
	const items = settings.get("profiles.items");
	const active = getActiveProfileName();
	const result: ProfileInfo[] = [];
	for (const [name, raw] of Object.entries(items)) {
		const snapshot = asSnapshot(raw);
		if (!snapshot) continue;
		result.push({ name, isActive: name === active, snapshot });
	}
	result.sort((a, b) => a.name.localeCompare(b.name));
	return result;
}

/** Get the valid active profile name, or undefined for an empty/stale/malformed marker. */
export function getActiveProfileName(): string | undefined {
	const active = settings.get("profiles.active");
	if (!active) return undefined;
	return asSnapshot(settings.get("profiles.items")[active]) ? active : undefined;
}

/** Capture enough live state to roll back a failed session-level profile apply. */
export function captureProfileActivationState(): ProfileActivationState {
	return { name: getActiveProfileName(), snapshot: captureCurrentSnapshot() };
}

/** Restore live profile settings after a failed session-level apply. */
export function restoreProfileActivation(state: ProfileActivationState): void {
	settings.restoreProfileActivation(state.name, state.snapshot);
}

/**
 * Add a new profile. If no profiles exist yet, auto-captures "default" first.
 * Sets the new profile as active.
 * Throws if the name already exists.
 */
export function addProfile(name: string, snapshot?: ProfileSnapshot): void {
	const items = settings.get("profiles.items");

	if (name in items) {
		throw new Error(`Profile "${name}" already exists`);
	}

	// Auto-create "default" from current config if no profiles exist
	if (Object.keys(items).length === 0 && name !== "default") {
		settings.setProfileItem("default", captureCurrentSnapshot());
	}

	const nextSnapshot = snapshot ?? captureCurrentSnapshot();
	settings.setProfileItem(name, nextSnapshot);
	settings.activateProfile(name, nextSnapshot);
}

/**
 * Switch to an existing profile, overwriting live modelRoles and defaultThinkingLevel.
 * Throws if profile not found.
 */
export function switchProfile(name: string): void {
	const items = settings.get("profiles.items");
	const snapshot = asSnapshot(items[name]);
	if (!snapshot) {
		throw new Error(`Profile "${name}" not found`);
	}

	const active = getActiveProfileName();

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
	settings.activateProfile(name, snapshot);
}

/**
 * Delete a profile. When deleting the selected profile, activates the first
 * remaining valid profile alphabetically and applies its live settings.
 * Clears selection when none remain. Throws if the named key does not exist.
 */
export function deleteProfile(name: string): ProfileDeleteResult {
	const items = settings.get("profiles.items");
	if (!(name in items)) {
		throw new Error(`Profile "${name}" not found`);
	}

	const rawActive = settings.get("profiles.active");
	settings.deleteProfileItem(name);

	if (rawActive !== name) {
		return { deletedName: name };
	}

	const active = getActiveProfileName();
	const fallback = active ? asSnapshot(settings.get("profiles.items")[active]) : undefined;
	if (!active || !fallback) {
		return { deletedName: name };
	}
	return { deletedName: name, activated: { name: active, snapshot: fallback } };
}

/** Rename a profile. Throws if old not found or new already exists. */
export function renameProfile(oldName: string, newName: string): void {
	const items = settings.get("profiles.items");
	if (!(oldName in items)) {
		throw new Error(`Profile "${oldName}" not found`);
	}
	if (newName in items) {
		throw new Error(`Profile "${newName}" already exists`);
	}

	const wasActive = settings.get("profiles.active") === oldName;
	const snapshot = asSnapshot(items[oldName]);
	if (!snapshot) {
		throw new Error(`Profile "${oldName}" is malformed`);
	}
	settings.renameProfileItem(oldName, newName, snapshot, wasActive);
}

/** Re-capture the current live config into the active profile. No-op if no active profile. */
export function saveActiveProfile(): void {
	const active = getActiveProfileName();
	if (!active) {
		throw new Error("No active profile to save");
	}

	const snapshot = captureCurrentSnapshot();
	settings.set("modelRoles", snapshot.modelRoles);
	settings.set("defaultThinkingLevel", snapshot.defaultThinkingLevel as SettingValue<"defaultThinkingLevel">);
}

/**
 * Cycle to the next profile (sorted alphabetically, wrapping).
 * Returns the profile switched to, or undefined if fewer than 2 profiles exist.
 */
export function cycleProfile(): ProfileCycleResult | undefined {
	const profiles = listProfiles();
	if (profiles.length < 2) return undefined;

	const active = getActiveProfileName();
	const currentIndex = active ? profiles.findIndex(profile => profile.name === active) : -1;
	const next = profiles[(currentIndex + 1) % profiles.length];
	switchProfile(next.name);
	return { name: next.name, snapshot: next.snapshot };
}

/** Auto-create a "default" profile from current config if no profiles exist. */
export function ensureDefaultProfile(): void {
	const items = settings.get("profiles.items");
	if (Object.keys(items).length === 0) {
		addProfile("default");
	}
}
