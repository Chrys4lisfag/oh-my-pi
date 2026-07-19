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

export interface ProfileCycleResult {
	name: string;
	snapshot: ProfileSnapshot;
}

/** Validate and cast a raw object to ProfileSnapshot, returning undefined if invalid. */
function asSnapshot(raw: unknown): ProfileSnapshot | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const obj = raw as Record<string, unknown>;
	if (typeof obj.defaultThinkingLevel !== "string") return undefined;
	if (typeof obj.modelRoles !== "object" || obj.modelRoles === null) return undefined;
	return {
		modelRoles: obj.modelRoles as Record<string, string>,
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

/** Get the name of the currently active profile, or undefined if none. */
export function getActiveProfileName(): string | undefined {
	const active = settings.get("profiles.active");
	return active || undefined;
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

	settings.setProfileItem(name, snapshot ?? captureCurrentSnapshot());
	settings.set("profiles.active", name);
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

	// Auto-save live config back to the active profile before switching, then
	// pin the target. Both go through the per-key `setProfileItem` so a
	// concurrent instance's other profiles are never clobbered on save.
	if (active && active in items) {
		settings.setProfileItem(active, captureCurrentSnapshot());
	}
	settings.setProfileItem(name, snapshot); // keep the validated copy
	settings.set("modelRoles", snapshot.modelRoles);
	settings.set("defaultThinkingLevel", snapshot.defaultThinkingLevel as SettingValue<"defaultThinkingLevel">);
	settings.set("profiles.active", name);
}

/** Delete a profile. Throws if not found. Clears active if deleting the active profile. */
export function deleteProfile(name: string): void {
	const items = settings.get("profiles.items");
	if (!(name in items)) {
		throw new Error(`Profile "${name}" not found`);
	}

	settings.deleteProfileItem(name);

	if (getActiveProfileName() === name) {
		settings.set("profiles.active", "");
	}
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

	const snapshot = asSnapshot(items[oldName]);
	if (!snapshot) {
		throw new Error(`Profile "${oldName}" is malformed`);
	}
	settings.setProfileItem(newName, snapshot);
	settings.deleteProfileItem(oldName);

	if (getActiveProfileName() === oldName) {
		settings.set("profiles.active", newName);
	}
}

/** Re-capture the current live config into the active profile. No-op if no active profile. */
export function saveActiveProfile(): void {
	const active = getActiveProfileName();
	if (!active) {
		throw new Error("No active profile to save");
	}

	settings.setProfileItem(active, captureCurrentSnapshot());
}

/**
 * Cycle to the next profile (sorted alphabetically, wrapping).
 * Returns the profile switched to, or undefined if fewer than 2 profiles exist.
 */
export function cycleProfile(): ProfileCycleResult | undefined {
	const items = settings.get("profiles.items");
	const names = Object.keys(items).sort();
	if (names.length < 2) return undefined;

	const active = getActiveProfileName();
	const currentIndex = active ? names.indexOf(active) : -1;
	const nextIndex = (currentIndex + 1) % names.length;
	const nextName = names[nextIndex];

	switchProfile(nextName);

	const snapshot = asSnapshot(items[nextName]);
	if (!snapshot) return undefined;

	return { name: nextName, snapshot };
}

/** Auto-create a "default" profile from current config if no profiles exist. */
export function ensureDefaultProfile(): void {
	const items = settings.get("profiles.items");
	if (Object.keys(items).length === 0) {
		addProfile("default");
	}
}
