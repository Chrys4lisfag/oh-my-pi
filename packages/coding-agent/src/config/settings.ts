/**
 * Settings singleton with sync get/set and background persistence.
 *
 * Usage:
 *   import { settings } from "./settings";
 *
 *   const enabled = settings.get("compaction.enabled");  // sync read
 *   settings.set("theme.dark", "titanium");               // sync write, saves in background
 *
 * For tests:
 *   const isolated = Settings.isolated({ "compaction.enabled": false });
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { configureCredentialRedaction } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { configureProviderMaxInFlightRequests } from "@oh-my-pi/pi-ai/stream";
import {
	getAgentDbPath,
	getAgentDir,
	getLastChangelogVersionPath,
	getProjectDir,
	hasFsCode,
	isEnoent,
	logger,
	MAIN_CONFIG_FILENAMES,
	procmgr,
	setWorktreesDir,
	toError,
} from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { JSONC, YAML } from "bun";
import { invalidate as invalidateCapabilityFsCache } from "../capability/fs";
import { type Settings as SettingsCapabilityItem, settingsCapability } from "../capability/settings";
import type { ModelRole } from "../config/model-roles";
import { loadCapability } from "../discovery";
import { isLightTheme, setAutoThemeMapping, setColorBlindMode, setSymbolPreset } from "../modes/theme/theme";
import { AgentStorage } from "../session/agent-storage";
import { type CompactionMethod, DEFAULT_COMPACTION_METHOD_ORDER } from "../session/compaction-methods";
import { AUTO_IMAGE_PROVIDER_ORDER, isImageProviderId } from "../tools/image-providers";
import { type EditMode, normalizeEditMode } from "../utils/edit-mode";
import { INSPECT_IMAGE_MODES } from "../utils/inspect-image-mode";
import { isSearchProviderId, SEARCH_PROVIDER_ORDER } from "../web/search/types";
import {
	type BashInterceptorRule,
	type GroupPrefix,
	type GroupTypeMap,
	getDefault,
	SETTINGS_SCHEMA,
	type SettingPath,
	type SettingValue,
} from "./settings-schema";

// Re-export types that callers need
export type * from "./settings-schema";
export * from "./settings-schema";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/** Raw settings object as stored in YAML */
export interface RawSettings {
	[key: string]: unknown;
}

type YamlLoadResult =
	| { kind: "missing" }
	| { kind: "loaded"; settings: RawSettings }
	| { kind: "invalid"; error: unknown; backupPath?: string }
	| { kind: "unreadable"; error: unknown };

type MainYamlReadResult = {
	settings: RawSettings | null;
	configPath: string | null;
};

type ProjectSettingsReadResult = {
	settings: RawSettings;
	fileSettings: RawSettings;
	shellPathSource: string | undefined;
};

type ConfigOverlayReadResult = {
	settings: RawSettings;
	shellPathSource: string | undefined;
};

export interface SettingsOptions {
	/** Current working directory for project settings discovery */
	cwd?: string;
	/** Agent directory for config.yml/config.yaml storage */
	agentDir?: string;
	/** Don't persist to disk (for tests) */
	inMemory?: boolean;
	/** Read config sources without opening storage or writing migrations */
	readOnly?: boolean;
	/** Initial overrides */
	overrides?: Partial<Record<SettingPath, unknown>>;
	/** Extra config.yml-style overlays loaded after global/project settings */
	configFiles?: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Path Utilities
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get a nested value from an object by path segments.
 */
function getByPath(obj: RawSettings, segments: readonly string[]): unknown {
	let current: unknown = obj;
	for (const segment of segments) {
		if (current === null || current === undefined || typeof current !== "object") {
			return undefined;
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

const SETTING_PATH_SEGMENTS: Record<SettingPath, readonly string[]> = Object.fromEntries(
	(Object.keys(SETTINGS_SCHEMA) as SettingPath[]).map(settingPath => [settingPath, settingPath.split(".")]),
) as unknown as Record<SettingPath, readonly string[]>;

/**
 * Set a nested value in an object by path segments.
 * Creates intermediate objects as needed.
 */
function setByPath(obj: RawSettings, segments: string[], value: unknown): void {
	let current = obj;
	for (let i = 0; i < segments.length - 1; i++) {
		const segment = segments[i];
		if (!(segment in current) || typeof current[segment] !== "object" || current[segment] === null) {
			current[segment] = {};
		}
		current = current[segment] as RawSettings;
	}
	current[segments[segments.length - 1]] = value;
}

export function normalizeProviderMaxInFlightRequests(value: unknown): Record<string, number> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const normalized: Record<string, number> = {};
	for (const [provider, rawLimit] of Object.entries(value)) {
		if (typeof rawLimit !== "number" || !Number.isFinite(rawLimit) || rawLimit <= 0) continue;
		normalized[provider] = Math.max(1, Math.floor(rawLimit));
	}
	return normalized;
}

export function validateProviderMaxInFlightRequests(value: unknown): Record<string, number> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const invalidProviders: string[] = [];
	const normalized: Record<string, number> = {};
	for (const [provider, rawLimit] of Object.entries(value)) {
		if (typeof rawLimit !== "number" || !Number.isFinite(rawLimit) || rawLimit <= 0) {
			invalidProviders.push(provider);
			continue;
		}
		normalized[provider] = Math.max(1, Math.floor(rawLimit));
	}
	if (invalidProviders.length > 0) {
		throw new Error(`Provider request limits must be positive numbers: ${invalidProviders.join(", ")}`);
	}
	return normalized;
}

const PATH_SCOPED_ARRAY_SETTINGS = new Set<SettingPath>(["enabledModels", "disabledProviders"]);
type PathScopedStringArrayEntry = {
	path?: unknown;
	paths?: unknown;
	pathPrefix?: unknown;
	pathPrefixes?: unknown;
	values?: unknown;
	items?: unknown;
	models?: unknown;
	providers?: unknown;
};

function expandTilde(p: string): string {
	return p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function normalizePathPrefix(prefix: string): string {
	return path.resolve(expandTilde(prefix));
}

function pathMatchesPrefix(cwd: string, prefix: string): boolean {
	const relative = path.relative(normalizePathPrefix(prefix), path.resolve(cwd));
	return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function stringArrayFromUnknown(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
	return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Migrate a v17 leaf rename that used to nest under a boolean parent path
 * (`dev.autoqa.consent` → `dev.autoqaConsent`, `todo.reminders.max` →
 * `todo.remindersMax`). Pre-rename configs left the leaf beneath the parent,
 * so the parent path resolved to an object and truthy checks like
 * `isAutoQaEnabled` treated a consent-only container as "enabled".
 *
 * Handles nested (`{ parent: { leaf } }`) and quoted-dotted (`"parent.leaf"`)
 * legacy sources. An explicit new key always wins; a separately configured
 * boolean parent is preserved; an irrecoverable object-valued parent (only ever
 * a container for the old leaf) is dropped so the schema default applies.
 */
function migrateNestedLeafRename(
	raw: RawSettings,
	root: string,
	parent: string,
	oldLeaf: string,
	newLeaf: string,
	isLeafValue: (value: unknown) => boolean,
): void {
	const rootObj = isRecord(raw[root]) ? (raw[root] as Record<string, unknown>) : undefined;
	const nestedParent = rootObj?.[parent];
	const flatParent = raw[`${root}.${parent}`];
	const oldParentPath = `${root}.${parent}`;

	const candidates = [
		rootObj?.[newLeaf],
		raw[`${root}.${newLeaf}`],
		isRecord(nestedParent) ? nestedParent[oldLeaf] : undefined,
		raw[`${oldParentPath}.${oldLeaf}`],
	];
	const resolvedLeaf = candidates.find(isLeafValue);

	const recoveredParent =
		typeof nestedParent === "boolean" ? nestedParent : typeof flatParent === "boolean" ? flatParent : undefined;

	const ensureRoot = (): Record<string, unknown> => {
		const current = raw[root];
		if (isRecord(current)) return current;
		const created: Record<string, unknown> = {};
		raw[root] = created;
		return created;
	};

	if (resolvedLeaf !== undefined) {
		const target = ensureRoot();
		if (!isLeafValue(target[newLeaf])) {
			target[newLeaf] = resolvedLeaf;
		}
	}

	// Strip legacy leaf sources (nested + flat dotted).
	delete raw[`${oldParentPath}.${oldLeaf}`];
	delete raw[`${root}.${newLeaf}`];
	if (isRecord(raw[root]) && isRecord((raw[root] as Record<string, unknown>)[parent])) {
		const parentObj = (raw[root] as Record<string, unknown>)[parent] as Record<string, unknown>;
		delete parentObj[oldLeaf];
		if (Object.keys(parentObj).length === 0) {
			delete (raw[root] as Record<string, unknown>)[parent];
		}
	}

	// The parent path must be a boolean or absent — never a leftover object.
	if (recoveredParent !== undefined) {
		const target = ensureRoot();
		if (typeof target[parent] !== "boolean") {
			target[parent] = recoveredParent;
		}
	} else if (isRecord(raw[root]) && isRecord((raw[root] as Record<string, unknown>)[parent])) {
		delete (raw[root] as Record<string, unknown>)[parent];
	}
	delete raw[oldParentPath];
	if (isRecord(raw[root]) && Object.keys(raw[root] as Record<string, unknown>).length === 0) {
		delete raw[root];
	}
}

function modelRoleValueFromUnknown(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return undefined;

	const entries = stringArrayFromUnknown(value);
	return entries.length === value.length ? entries.join(",") : undefined;
}

type EditVariantEntry = {
	patternLower: string;
	mode: EditMode;
};

function resolvePathScopedStringArray(settingPath: SettingPath, value: unknown, cwd: string): string[] | undefined {
	if (!PATH_SCOPED_ARRAY_SETTINGS.has(settingPath) || !Array.isArray(value)) return undefined;

	const resolved: string[] = [];
	for (const entry of value) {
		if (typeof entry === "string") {
			resolved.push(entry);
			continue;
		}
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;

		const scoped = entry as PathScopedStringArrayEntry;
		const prefixes = [
			...stringArrayFromUnknown(scoped.path),
			...stringArrayFromUnknown(scoped.paths),
			...stringArrayFromUnknown(scoped.pathPrefix),
			...stringArrayFromUnknown(scoped.pathPrefixes),
		];
		if (prefixes.length === 0 || !prefixes.some(prefix => pathMatchesPrefix(cwd, prefix))) continue;

		const values =
			settingPath === "enabledModels"
				? [
						...stringArrayFromUnknown(scoped.values),
						...stringArrayFromUnknown(scoped.items),
						...stringArrayFromUnknown(scoped.models),
					]
				: [
						...stringArrayFromUnknown(scoped.values),
						...stringArrayFromUnknown(scoped.items),
						...stringArrayFromUnknown(scoped.providers),
					];
		resolved.push(...values);
	}

	return resolved;
}

// ═══════════════════════════════════════════════════════════════════════════
// Settings Class
// ═══════════════════════════════════════════════════════════════════════════

export class Settings {
	#configPath: string | null;
	#cwd: string;
	#agentDir: string;
	#storage: AgentStorage | null = null;

	#configFiles: string[] = [];
	/** Global settings from config.yml/config.yaml */
	#global: RawSettings = {};
	/** Project settings from .claude/settings.yml etc */
	#project: RawSettings = {};
	/** Last successfully loaded native .omp/config.yml contents. */
	#projectFileSettings: RawSettings = {};
	/** Logical config paths whose malformed targets were moved aside. */
	#quarantinedYamlTargets = new Map<string, string>();
	/** Extra config.yml-style overlays passed by CLI */
	#configOverlay: RawSettings = {};
	/** Project settings file that most recently supplied shellPath. */
	#projectShellPathSource: string | undefined;
	/** Explicit config overlay that most recently supplied shellPath. */
	#overlayShellPathSource: string | undefined;
	/** Runtime overrides (not persisted) */
	#overrides: RawSettings = {};
	/** Merged view (global + project + overrides) */
	#merged: RawSettings = {};
	/** Cached resolved values from the merged view, including defaults/path scoping */
	#resolvedCache = new Map<SettingPath, unknown>();
	#editVariantCache: readonly EditVariantEntry[] | undefined;

	/** Paths modified during this session (for partial save) */
	#modified = new Set<string>();
	/** Profile names changed locally. Creates may add an absent key; stale updates never resurrect a concurrently deleted profile. */
	#modifiedProfileItems = new Map<string, "create" | "update" | "delete">();
	/** Profile-owned live edits merged per field/role so stale terminals do not clobber disjoint edits. */
	#modifiedProfileLiveFields = new Map<
		string,
		{ defaultThinkingLevel?: string; modelRoles: Map<string, string | undefined> }
	>();
	/** Cross-key profile renames, committed only when the source still exists and destination is still absent on disk. */
	#modifiedProfileRenames = new Map<
		string,
		{
			newName: string;
			snapshot: { modelRoles: Record<string, string>; defaultThinkingLevel: string };
			wasActive: boolean;
		}
	>();
	/** Individual project model roles modified during this session */
	#modifiedProjectModelRoles = new Set<string>();
	/** Individual global model roles modified during this session (for partial save) */
	#modifiedGlobalModelRoles = new Set<string>();
	/** Changes whenever a live API mutates a persisted layer. */
	#persistedMutationGeneration = 0;
	/**
	 * Original process-wide model-role overrides captured before a project edit
	 * temporarily replaced them via `#updateRuntimeModelRoleOverride`. Restored
	 * on `reloadForCwd` / `cloneForCwd` so destination projects never inherit the
	 * source-project value. Maps role → original override value (`undefined`
	 * when the role had no runtime override).
	 */
	#savedRuntimeModelRoleOverrides = new Map<string, string | undefined>();
	/**
	 * Runtime override slots currently owned by active profile. Each entry
	 * records value displaced by profile activation so removing final profile
	 * restores explicit runtime state instead of inferring ownership from value.
	 */
	#profileOwnedModelRoleOverrides = new Map<
		string,
		{ profile: string; hadPrevious: boolean; previousValue?: unknown }
	>();
	#profileOwnedThinkingOverride?: { profile: string; hadPrevious: boolean; previousValue?: unknown };
	#profileRuntimeOwner?: string;
	/** Prevent activation rollback helpers from rewriting a saved profile snapshot. */
	#suppressActiveProfileSnapshotUpdate = false;
	/** Pending activation; target snapshot is resolved from freshest disk state under write lock. */
	#modifiedProfileActivation?: { targetName: string };

	/** Legacy `lastChangelogVersion` captured from config.yml during migration (now a marker file). */
	#legacyLastChangelogVersion?: string;

	/** Pending save (debounced) */
	#saveTimer?: NodeJS.Timeout;
	#savePromise?: Promise<void>;
	#projectSaveTimer?: NodeJS.Timeout;
	#projectSavePromise?: Promise<void>;
	#globalWatchTimer?: NodeJS.Timeout;
	#globalWatchFingerprint?: string;
	#externalReloadPromise?: Promise<void>;
	/** Incremented on cancellation so in-flight reloads cannot mutate discarded instances. */
	#lifecycleEpoch = 0;
	/** True for cwd clones whose creating session owns this instance's lifecycle. */
	#sessionOwned = false;
	/** Coalesces concurrent persisted-layer refreshes into one atomic reload. */
	#reloadFromDiskPromise?: Promise<void>;

	/** Whether to persist changes */
	#persist: boolean;

	private constructor(options: SettingsOptions = {}) {
		this.#cwd = path.normalize(options.cwd ?? getProjectDir());
		this.#agentDir = path.normalize(options.agentDir ?? getAgentDir());
		this.#configPath = options.inMemory ? null : path.join(this.#agentDir, MAIN_CONFIG_FILENAMES[0]);
		const configFiles = process.env.PI_CONFIG_FILES?.split(path.delimiter).filter(Boolean) ?? [];
		if (options.configFiles) configFiles.push(...options.configFiles);
		this.#configFiles = configFiles.map(file => path.resolve(this.#cwd, expandTilde(file)));
		this.#persist = !options.inMemory && options.readOnly !== true;
		liveSettingsInstances.add(new WeakRef(this));

		if (options.overrides) {
			for (const [key, value] of Object.entries(options.overrides)) {
				setByPath(this.#overrides, key.split("."), value);
			}

			this.#overrides = this.#migrateRawSettings(this.#overrides);
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Factory Methods
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Initialize the global singleton.
	 * Call once at startup before accessing `settings`.
	 */
	static init(options: SettingsOptions = {}): Promise<Settings> {
		if (globalInstancePromise) return globalInstancePromise;

		const instance = new Settings(options);
		const promise = instance.#load();
		globalInstancePromise = promise;

		return promise.then(
			instance => {
				globalInstance = instance;
				clearBoundSettingsMethods();
				globalInstancePromise = Promise.resolve(instance);
				return instance;
			},
			error => {
				globalInstance = null;
				globalInstancePromise = null;
				clearBoundSettingsMethods();
				throw error;
			},
		);
	}

	/**
	 * Load effective settings from config.yml and project providers without
	 * opening agent.db, migrating legacy settings, or writing marker files.
	 */
	static loadReadOnly(options: SettingsOptions = {}): Promise<Settings> {
		const instance = new Settings({ ...options, readOnly: true });
		return instance.#loadReadOnly();
	}

	/**
	 * Load a persisted settings instance without touching the global singleton.
	 */
	static loadIsolated(options: SettingsOptions = {}): Promise<Settings> {
		const instance = new Settings(options);
		return instance.#load();
	}

	/**
	 * Create an in-memory settings instance without affecting the global singleton.
	 * A supplied storage handle remains shared for runtime data while setting overrides stay non-persistent.
	 */
	static isolated(
		overrides: Partial<Record<SettingPath, unknown>> = {},
		options: { storage?: AgentStorage | null } = {},
	): Settings {
		const instance = new Settings({ inMemory: true, overrides });
		instance.#storage = options.storage ?? null;
		instance.#rebuildMerged();
		return instance;
	}

	/**
	 * Get the global singleton.
	 * Throws if not initialized.
	 */
	static get instance(): Settings {
		if (!globalInstance) {
			throw new Error("Settings not initialized. Call Settings.init() first.");
		}
		return globalInstance;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Core API
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Get a setting value (sync).
	 * Returns the merged value from global + project + overrides, or the default.
	 */
	get<P extends SettingPath>(path: P): SettingValue<P> {
		if (this.#resolvedCache.has(path)) {
			return this.#resolvedCache.get(path) as SettingValue<P>;
		}

		const value = getByPath(this.#merged, SETTING_PATH_SEGMENTS[path]);
		const resolved =
			value !== undefined ? (resolvePathScopedStringArray(path, value, this.#cwd) ?? value) : getDefault(path);
		this.#resolvedCache.set(path, resolved);
		return resolved as SettingValue<P>;
	}

	/**
	 * Whether `path` has an explicitly configured value (global config, project
	 * config, or runtime override) rather than falling back to the schema default.
	 */
	isConfigured(path: SettingPath): boolean {
		return getByPath(this.#merged, SETTING_PATH_SEGMENTS[path]) !== undefined;
	}

	/**
	 * Set a setting value (sync).
	 * Updates global settings and queues a background save.
	 * Triggers hooks for settings that have side effects.
	 */
	set<P extends SettingPath>(path: P, value: SettingValue<P>): void {
		const prev = this.get(path);
		const segments = path.split(".");
		setByPath(this.#global, segments, value);
		this.#persistedMutationGeneration++;
		if (this.#profileRuntimeOwner && path === "modelRoles") {
			this.#replaceProfileOwnedModelRoles(this.#profileRuntimeOwner, value as SettingValue<"modelRoles">);
			this.#updateActiveProfileSnapshot({ modelRoles: value as SettingValue<"modelRoles"> });
		} else if (this.#profileRuntimeOwner && path === "defaultThinkingLevel") {
			this.#setProfileOwnedThinkingOverride(
				this.#profileRuntimeOwner,
				value as SettingValue<"defaultThinkingLevel">,
			);
			this.#updateActiveProfileSnapshot({
				defaultThinkingLevel: value as SettingValue<"defaultThinkingLevel">,
			});
		}
		this.#modified.add(path);
		this.#rebuildMerged();
		const next = this.get(path);
		this.#queueSave();

		// Trigger hook if exists
		const hook = SETTING_HOOKS[path];
		if (hook) {
			hook(next, prev);
		}
		this.#fireEffectiveSettingChanged(path, next, prev);
	}

	/** Persist edits to profile-owned live fields back into that profile snapshot. */
	#updateActiveProfileSnapshot(
		update: Partial<{ modelRoles: Record<string, string>; defaultThinkingLevel: string }>,
	): void {
		if (this.#suppressActiveProfileSnapshotUpdate) return;
		const profile = this.#profileRuntimeOwner;
		if (!profile) return;
		const raw = getByPath(this.#global, ["profiles", "items", profile]);
		const snapshot = this.#profileSnapshotFromUnknown(raw);
		if (!snapshot) return;
		const next = {
			modelRoles: { ...(update.modelRoles ?? snapshot.modelRoles) },
			defaultThinkingLevel: update.defaultThinkingLevel ?? snapshot.defaultThinkingLevel,
		};
		setByPath(this.#global, ["profiles", "items", profile], next);

		let persistenceProfile = profile;
		for (;;) {
			const source = [...this.#modifiedProfileRenames].find(
				([, rename]) => rename.newName === persistenceProfile,
			)?.[0];
			if (!source) break;
			persistenceProfile = source;
		}
		let delta = this.#modifiedProfileLiveFields.get(persistenceProfile);
		if (!delta) {
			delta = { modelRoles: new Map() };
			this.#modifiedProfileLiveFields.set(persistenceProfile, delta);
		}
		if (update.modelRoles) {
			for (const role of new Set([...Object.keys(snapshot.modelRoles), ...Object.keys(next.modelRoles)])) {
				if (snapshot.modelRoles[role] === next.modelRoles[role]) continue;
				delta.modelRoles.set(role, next.modelRoles[role]);
			}
		}
		if (update.defaultThinkingLevel !== undefined && snapshot.defaultThinkingLevel !== next.defaultThinkingLevel) {
			delta.defaultThinkingLevel = next.defaultThinkingLevel;
		}
	}

	/**
	 * Upsert one profile snapshot with per-key persistence. Existing local keys
	 * are tracked as updates, so a stale omp process cannot recreate that key
	 * after another process deletes it. Brand-new local keys are creates and may
	 * intentionally add (or re-add) an absent profile.
	 */
	setProfileItem(name: string, snapshot: { modelRoles: Record<string, string>; defaultThinkingLevel: string }): void {
		const items = getByPath(this.#global, ["profiles", "items"]);
		const existed = isRecord(items) && Object.hasOwn(items, name);
		const pending = this.#modifiedProfileItems.get(name);
		setByPath(this.#global, ["profiles", "items", name], snapshot);
		this.#modifiedProfileItems.set(name, pending === "create" || !existed ? "create" : "update");
		this.#modifiedProfileLiveFields.delete(name);
		this.#persistedMutationGeneration++;
		this.#rebuildMerged();
		this.#queueSave();
	}

	/**
	 * Delete a single profile with per-key persistence (multi-instance safe;
	 * see {@link setProfileItem}). The deletion is propagated to the freshest
	 * on-disk map at save time without disturbing sibling profiles.
	 */
	deleteProfileItem(name: string): void {
		const items = getByPath(this.#global, ["profiles", "items"]);
		const rawActive = getByPath(this.#global, ["profiles", "active"]);
		if (items && typeof items === "object") {
			delete (items as Record<string, unknown>)[name];
		}
		this.#modifiedProfileItems.set(name, "delete");
		this.#modifiedProfileLiveFields.delete(name);
		this.#persistedMutationGeneration++;
		if (rawActive === name) {
			this.#reconcileDeletedActiveProfile(this.#global);
		} else if (typeof rawActive === "string" && rawActive.length > 0 && !this.#hasValidActiveProfile(this.#global)) {
			setByPath(this.#global, ["profiles", "active"], "");
		}
		this.#reconcileProfileRuntimeOverrides(this.#global);
		this.#rebuildMerged();
		this.#queueSave();
	}

	/** Apply one profile snapshot to persisted live config and profile-owned runtime slots. */
	applyProfileSnapshot(snapshot: { modelRoles: Record<string, string>; defaultThinkingLevel: string }): void {
		this.#suppressActiveProfileSnapshotUpdate = true;
		try {
			this.set("modelRoles", { ...snapshot.modelRoles });
			this.set("defaultThinkingLevel", snapshot.defaultThinkingLevel as SettingValue<"defaultThinkingLevel">);
		} finally {
			this.#suppressActiveProfileSnapshotUpdate = false;
		}
	}

	/**
	 * Bind this terminal's runtime profile ownership to `name` for a resumed
	 * session WITHOUT changing the durable startup profile marker on disk.
	 * Applies the stored snapshot to live role/thinking fields, reconciles
	 * profile-owned runtime slots, and notifies synchronized peers of the new
	 * local view. Returns false when `name` does not denote a valid profile.
	 *
	 * `#modifiedProfileActivation` is intentionally left untouched so the next
	 * save keeps the durable `profiles.active` marker owned by whoever created
	 * it; the binding is terminal-local and re-established on every resume.
	 */
	bindSessionToProfile(name: string): boolean {
		const items = getByPath(this.#global, ["profiles", "items"]);
		const snapshot = isRecord(items) ? this.#profileSnapshotFromUnknown(items[name]) : undefined;
		if (!snapshot) return false;
		const previous = this.#captureEffectiveSettings();
		setByPath(this.#global, ["profiles", "active"], name);
		setByPath(this.#global, ["modelRoles"], { ...snapshot.modelRoles });
		setByPath(this.#global, ["defaultThinkingLevel"], snapshot.defaultThinkingLevel);
		this.#replaceProfileRuntimeOverrides(name, snapshot);
		this.#persistedMutationGeneration++;
		this.#rebuildMerged();
		this.#notifySynchronizedSettings(previous, false);
		return true;
	}

	/**
	 * Retire terminal-local profile ownership for a legacy resumed session
	 * whose identity is unknown. Clears the in-memory active marker and all
	 * profile-owned runtime slots WITHOUT touching the durable startup profile
	 * on disk, so persisted model/thinking edits can never be written into an
	 * unrelated profile snapshot. The user re-binds via an explicit
	 * `/profiles switch`, at which point ownership (and header identity) is
	 * re-established.
	 */
	unbindSessionFromProfile(): void {
		if (!this.get("profiles.active")) return;
		const previous = this.#captureEffectiveSettings();
		this.#retireProfileRuntimeOverrides();
		setByPath(this.#global, ["profiles", "active"], "");
		this.#persistedMutationGeneration++;
		this.#rebuildMerged();
		this.#notifySynchronizedSettings(previous, false);
	}

	/** The valid active profile name, or undefined for an empty/stale/malformed marker. */
	activeProfileName(): string | undefined {
		const active = this.get("profiles.active");
		if (!active) return undefined;
		const items = this.get("profiles.items");
		return isRecord(items) && this.#profileSnapshotFromUnknown(items[active]) ? active : undefined;
	}

	/**
	 * Activate a profile conditionally. Persistence resolves target snapshot
	 * from disk while holding write lock; stale caller snapshot is live-only.
	 */
	activateProfile(name: string, snapshot: { modelRoles: Record<string, string>; defaultThinkingLevel: string }): void {
		const previous = this.#captureEffectiveSettings();
		setByPath(this.#global, ["profiles", "active"], name);
		setByPath(this.#global, ["modelRoles"], { ...snapshot.modelRoles });
		setByPath(this.#global, ["defaultThinkingLevel"], snapshot.defaultThinkingLevel);
		this.#replaceProfileRuntimeOverrides(name, snapshot);
		this.#modifiedProfileActivation = { targetName: name };
		this.#persistedMutationGeneration++;
		this.#rebuildMerged();
		this.#notifySynchronizedSettings(previous, false);
		this.#queueSave();
	}

	/** Restore a captured activation atomically, including runtime ownership provenance. */
	restoreProfileActivation(
		name: string | undefined,
		snapshot: { modelRoles: Record<string, string>; defaultThinkingLevel: string },
	): void {
		const items = getByPath(this.#global, ["profiles", "items"]);
		if (name && isRecord(items) && this.#profileSnapshotFromUnknown(items[name])) {
			this.activateProfile(name, snapshot);
			return;
		}
		const previous = this.#captureEffectiveSettings();
		setByPath(this.#global, ["profiles", "active"], "");
		setByPath(this.#global, ["modelRoles"], { ...snapshot.modelRoles });
		setByPath(this.#global, ["defaultThinkingLevel"], snapshot.defaultThinkingLevel);
		this.#retireProfileRuntimeOverrides();
		this.#modifiedProfileActivation = undefined;
		this.#modified.add("profiles.active");
		this.#modified.add("modelRoles");
		this.#modified.add("defaultThinkingLevel");
		this.#persistedMutationGeneration++;
		this.#rebuildMerged();
		this.#notifySynchronizedSettings(previous, false);
		this.#queueSave();
	}

	/** Rename one profile atomically against the freshest on-disk profile map. */
	renameProfileItem(
		oldName: string,
		newName: string,
		snapshot: { modelRoles: Record<string, string>; defaultThinkingLevel: string },
		wasActive: boolean,
	): void {
		const items = getByPath(this.#global, ["profiles", "items"]);
		if (isRecord(items)) {
			items[newName] = snapshot;
			delete items[oldName];
		}
		if (wasActive) {
			setByPath(this.#global, ["profiles", "active"], newName);
			if (this.#profileRuntimeOwner === oldName) {
				this.#profileRuntimeOwner = newName;
				for (const owned of this.#profileOwnedModelRoleOverrides.values()) owned.profile = newName;
				if (this.#profileOwnedThinkingOverride) this.#profileOwnedThinkingOverride.profile = newName;
			}
			if (this.#modifiedProfileActivation?.targetName === oldName) {
				this.#modifiedProfileActivation = { targetName: newName };
			}
		}
		this.#modifiedProfileRenames.set(oldName, { newName, snapshot, wasActive });
		this.#persistedMutationGeneration++;
		this.#rebuildMerged();
		this.#queueSave();
	}

	/**
	 * Apply runtime overrides (not persisted).
	 */
	override<P extends SettingPath>(path: P, value: SettingValue<P>): void {
		if (path === "modelRoles") {
			this.#supersedeAllProfileOwnedModelRoles();
			this.#savedRuntimeModelRoleOverrides.clear();
		} else if (path === "defaultThinkingLevel") {
			this.#supersedeProfileOwnedThinkingOverride();
		}
		const prev = this.get(path);
		const segments = path.split(".");
		setByPath(this.#overrides, segments, value);
		this.#rebuildMerged();
		this.#fireEffectiveSettingChanged(path, this.get(path), prev);
	}

	/**
	 * Clear a runtime override.
	 */
	clearOverride(path: SettingPath): void {
		if (path === "modelRoles") {
			this.#supersedeAllProfileOwnedModelRoles();
			this.#savedRuntimeModelRoleOverrides.clear();
		} else if (path === "defaultThinkingLevel") {
			this.#supersedeProfileOwnedThinkingOverride();
		}
		const prev = this.get(path);
		const segments = path.split(".");
		let current = this.#overrides;
		for (let i = 0; i < segments.length - 1; i++) {
			const segment = segments[i];
			if (!(segment in current)) return;
			current = current[segment] as RawSettings;
		}
		delete current[segments[segments.length - 1]];
		this.#rebuildMerged();
		this.#fireEffectiveSettingChanged(path, this.get(path), prev);
	}

	#fireEffectiveSettingChanged(path: SettingPath, value: unknown, prev: unknown): void {
		if (Object.is(value, prev)) return;
		if (path === "statusLine.sessionAccent") {
			statusLineSessionAccentSignal.fire();
		}
		if (path === "modelRoles") {
			modelRolesSignal.fire();
		}
	}

	/** Set once this instance is discarded; background saves become no-ops. */
	#savesCancelled = false;

	/**
	 * Drop pending debounced saves and refuse any further background writes.
	 * Used when an instance is being discarded (test teardown): an armed timer
	 * or a chained in-flight save on a dropped instance would otherwise fire
	 * later and race the successor's file locks.
	 */
	cancelPendingSaves(): void {
		this.#savesCancelled = true;
		this.#lifecycleEpoch++;
		clearTimeout(this.#saveTimer);
		this.#saveTimer = undefined;
		clearTimeout(this.#projectSaveTimer);
		this.#projectSaveTimer = undefined;
		clearInterval(this.#globalWatchTimer);
		this.#globalWatchTimer = undefined;
		this.#globalWatchFingerprint = undefined;
	}

	/** Cancel new work and wait until already-started saves/reloads release file handles. */
	async dispose(): Promise<void> {
		this.cancelPendingSaves();
		await Promise.allSettled(
			[this.#savePromise, this.#projectSavePromise, this.#externalReloadPromise].filter(
				(promise): promise is Promise<void> => promise !== undefined,
			),
		);
	}

	/** Stop external synchronization promptly while preserving pending local saves. */
	cancelIfSessionOwned(): void {
		if (!this.#sessionOwned) return;
		this.#lifecycleEpoch++;
		clearInterval(this.#globalWatchTimer);
		this.#globalWatchTimer = undefined;
		this.#globalWatchFingerprint = undefined;
	}

	/** Persist pending local edits, then drain all owned background work. */
	async disposeIfSessionOwned(): Promise<void> {
		if (!this.#sessionOwned) return;
		try {
			await this.flush();
		} catch (error) {
			logger.warn("Settings: failed to flush session-owned settings during dispose", { error: String(error) });
		}
		await this.dispose();
	}

	/**
	 * Flush any pending saves to disk.
	 * Call before exit to ensure all changes are persisted.
	 */
	async flush(): Promise<void> {
		if (this.#saveTimer) {
			clearTimeout(this.#saveTimer);
			this.#saveTimer = undefined;
		}
		if (this.#projectSaveTimer) {
			clearTimeout(this.#projectSaveTimer);
			this.#projectSaveTimer = undefined;
		}
		if (this.#savePromise) {
			await this.#savePromise;
		}
		if (this.#projectSavePromise) {
			await this.#projectSavePromise;
		}
		if (
			this.#modified.size > 0 ||
			this.#modifiedProfileItems.size > 0 ||
			this.#modifiedProfileRenames.size > 0 ||
			this.#modifiedGlobalModelRoles.size > 0 ||
			this.#modifiedProfileActivation !== undefined
		) {
			await this.#saveNow();
		}
		if (this.#modifiedProjectModelRoles.size > 0) {
			await this.#saveProjectNow();
		}
	}

	async cloneForCwd(cwd: string): Promise<Settings> {
		const cloned = new Settings({
			cwd,
			agentDir: this.#agentDir,
			inMemory: !this.#persist,
		});
		cloned.#storage = this.#storage;
		cloned.#configPath = this.#configPath;
		cloned.#sessionOwned = true;
		cloned.#global = structuredClone(this.#global);
		cloned.#project = this.#persist ? await cloned.#loadProjectSettings() : structuredClone(this.#project);
		if (!this.#persist) cloned.#projectShellPathSource = this.#projectShellPathSource;
		cloned.#configFiles = [...this.#configFiles];
		cloned.#configOverlay = structuredClone(this.#configOverlay);
		cloned.#overlayShellPathSource = this.#overlayShellPathSource;
		cloned.#overrides = this.#buildOriginalOverrides();
		cloned.#reconcileProfileRuntimeOverrides(cloned.#global);
		cloned.#rebuildMerged();
		cloned.#fireAllHooks();
		cloned.#startGlobalSettingsWatch();
		return cloned;
	}

	/**
	 * Re-read the current global, project, and explicit overlay layers from disk
	 * without replacing this instance or discarding runtime overrides.
	 *
	 * All sources are loaded before any live layer is replaced, so readers never
	 * observe a partially refreshed configuration. Concurrent callers share the
	 * same reload.
	 */
	async reloadFromDisk(): Promise<void> {
		if (!this.#persist) return;
		if (this.#reloadFromDiskPromise) return this.#reloadFromDiskPromise;

		const reload = this.#reloadPersistedLayers();
		this.#reloadFromDiskPromise = reload;
		try {
			await reload;
		} finally {
			if (this.#reloadFromDiskPromise === reload) {
				this.#reloadFromDiskPromise = undefined;
			}
		}
	}

	async #reloadPersistedLayers(): Promise<void> {
		for (;;) {
			await this.flush();
			const mutationGeneration = this.#persistedMutationGeneration;
			const previous = this.#captureEffectiveSettings();
			const previousGlobal = this.#global;

			const [globalResult, projectResult, overlayResult] = await Promise.allSettled([
				this.#readExistingMainYaml(false),
				this.#readProjectSettings(false),
				this.#readConfigOverlays(false),
			]);
			if (mutationGeneration !== this.#persistedMutationGeneration) continue;
			if (globalResult.status === "rejected") throw globalResult.reason;
			if (projectResult.status === "rejected") throw projectResult.reason;
			if (overlayResult.status === "rejected") throw overlayResult.reason;

			this.#configPath = globalResult.value.configPath;
			this.#global = globalResult.value.settings ?? {};
			this.#project = projectResult.value.settings;
			this.#projectFileSettings = projectResult.value.fileSettings;
			this.#projectShellPathSource = projectResult.value.shellPathSource;
			this.#configOverlay = overlayResult.value.settings;
			this.#overlayShellPathSource = overlayResult.value.shellPathSource;
			this.#reconcileDeletedActiveProfile(this.#global);
			this.#reconcileProfileRuntimeOverrides(this.#global, previousGlobal);
			this.#rebuildMerged();
			this.#notifySynchronizedSettings(previous);
			return;
		}
	}

	/**
	 * Re-scope this instance to a new working directory *in place*: reload the
	 * project layer (`.claude/settings.yml` etc.) from `cwd`, re-resolve
	 * path-scoped settings against it, and re-fire side-effect hooks (theme,
	 * symbols, tab width, …). Global settings and runtime overrides are preserved.
	 *
	 * Unlike {@link cloneForCwd}, this mutates the live instance, so every holder
	 * (the `settings` proxy, the active session, controllers) observes the new
	 * project scope without swapping references — used when the process changes
	 * directory mid-run (`/move`, cross-project resume). No-op when `cwd` is
	 * already the current scope.
	 */
	async reloadForCwd(cwd: string): Promise<void> {
		const normalized = path.normalize(cwd);
		if (normalized === this.#cwd) return;
		await this.flush();
		this.#restoreRuntimeModelRoleOverrides();
		const prevModelRoles = this.get("modelRoles");
		this.#cwd = normalized;
		if (this.#persist) {
			this.#project = await this.#loadProjectSettings();
		}
		this.#rebuildMerged();
		this.#fireEffectiveSettingChanged("modelRoles", this.get("modelRoles"), prevModelRoles);
		this.#fireAllHooks();
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Accessors
	// ─────────────────────────────────────────────────────────────────────────

	getStorage(): AgentStorage | null {
		return this.#storage;
	}

	getCwd(): string {
		return this.#cwd;
	}

	getAgentDir(): string {
		return this.#agentDir;
	}

	getPlansDirectory(): string {
		return path.join(this.#agentDir, "plans");
	}

	/**
	 * Get shell configuration based on settings.
	 */
	getShellConfig() {
		const shell = this.get("shellPath");
		let configSource = this.#configPath ?? path.join(this.#agentDir, MAIN_CONFIG_FILENAMES[0]);
		if (Object.hasOwn(this.#project, "shellPath")) {
			configSource = this.#projectShellPathSource ?? "the active project configuration";
		}
		if (Object.hasOwn(this.#configOverlay, "shellPath")) {
			configSource = this.#overlayShellPathSource ?? "the active config overlay";
		}
		if (Object.hasOwn(this.#overrides, "shellPath")) {
			configSource = "the runtime settings override";
		}
		return procmgr.getShellConfig(shell, { configSource });
	}

	/**
	 * Get all settings in a group with full type safety.
	 */
	getGroup<G extends GroupPrefix>(prefix: G): GroupTypeMap[G] {
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
			if (key.startsWith(`${prefix}.`)) {
				const suffix = key.slice(prefix.length + 1);
				result[suffix] = this.get(key);
			}
		}
		return result as unknown as GroupTypeMap[G];
	}

	/**
	 * Get the edit variant for a specific model.
	 * Returns "patch", "replace", "hashline", "apply_patch", or null (use global default).
	 */
	getEditVariantForModel(model: string | undefined): EditMode | null {
		if (!model) return null;
		const variants = this.#getEditVariantEntries();
		if (variants.length === 0) return null;

		const modelLower = model.toLowerCase();

		for (let i = 0; i < variants.length; i++) {
			const variant = variants[i];
			if (modelLower.includes(variant.patternLower)) {
				return variant.mode;
			}
		}
		return null;
	}

	#getEditVariantEntries(): readonly EditVariantEntry[] {
		if (this.#editVariantCache !== undefined) return this.#editVariantCache;

		const value = getByPath(this.#merged, ["edit", "modelVariants"]);
		if (!isRecord(value)) {
			this.#editVariantCache = [];
			return this.#editVariantCache;
		}

		const variants: EditVariantEntry[] = [];
		for (const pattern in value) {
			if (!Object.hasOwn(value, pattern)) continue;
			const rawMode = value[pattern];
			if (typeof rawMode !== "string") continue;
			const mode = normalizeEditMode(rawMode);
			if (mode) {
				variants.push({ patternLower: pattern.toLowerCase(), mode });
			}
		}

		this.#editVariantCache = variants;
		return variants;
	}

	/**
	 * Get bash interceptor rules (typed accessor for complex array config).
	 */
	getBashInterceptorRules(): BashInterceptorRule[] {
		return this.get("bashInterceptor.patterns");
	}

	#modelRolesFromLayer(layer: RawSettings): Record<string, string> {
		const value = getByPath(layer, ["modelRoles"]);
		if (!isRecord(value)) return {};

		const roles: Record<string, string> = {};
		for (const role in value) {
			if (!Object.hasOwn(value, role)) continue;
			const modelId = modelRoleValueFromUnknown(value[role]);
			if (modelId !== undefined) {
				roles[role] = modelId;
			}
		}
		return roles;
	}

	#modelRoleLayerOwns(layer: RawSettings, role: ModelRole | string): boolean {
		const value = getByPath(layer, ["modelRoles"]);
		if (!isRecord(value)) return false;
		return Object.hasOwn(value, role);
	}
	#getRuntimeModelRoleOverrides(): Record<string, unknown> {
		const raw = getByPath(this.#overrides, ["modelRoles"]);
		if (isRecord(raw)) return raw;
		const roles: Record<string, unknown> = {};
		setByPath(this.#overrides, ["modelRoles"], roles);
		return roles;
	}

	#setProfileOwnedModelRole(profile: string, role: string, modelId: string): void {
		const runtimeRoles = this.#getRuntimeModelRoleOverrides();
		if (!this.#profileOwnedModelRoleOverrides.has(role)) {
			this.#profileOwnedModelRoleOverrides.set(role, {
				profile,
				hadPrevious: Object.hasOwn(runtimeRoles, role),
				previousValue: structuredClone(runtimeRoles[role]),
			});
		}
		runtimeRoles[role] = modelId;
	}

	#retireProfileOwnedModelRole(role: string): void {
		const owned = this.#profileOwnedModelRoleOverrides.get(role);
		if (!owned) return;
		const runtimeRoles = this.#getRuntimeModelRoleOverrides();
		if (owned.hadPrevious) runtimeRoles[role] = structuredClone(owned.previousValue);
		else delete runtimeRoles[role];
		this.#profileOwnedModelRoleOverrides.delete(role);
	}

	#retireAllProfileOwnedModelRoles(): void {
		for (const role of [...this.#profileOwnedModelRoleOverrides.keys()]) {
			this.#retireProfileOwnedModelRole(role);
		}
	}

	#supersedeProfileOwnedModelRole(role: string, preserveForProject = false): void {
		const owned = this.#profileOwnedModelRoleOverrides.get(role);
		if (!owned) return;
		if (preserveForProject && !this.#savedRuntimeModelRoleOverrides.has(role)) {
			const previous = owned.hadPrevious ? modelRoleValueFromUnknown(owned.previousValue) : undefined;
			this.#savedRuntimeModelRoleOverrides.set(role, previous);
		}
		this.#profileOwnedModelRoleOverrides.delete(role);
	}

	#supersedeAllProfileOwnedModelRoles(): void {
		this.#profileOwnedModelRoleOverrides.clear();
	}

	#replaceProfileOwnedModelRoles(profile: string, roles: ReadOnlyDict<string>): void {
		for (const role of [...this.#profileOwnedModelRoleOverrides.keys()]) {
			if (!Object.hasOwn(roles, role)) this.#retireProfileOwnedModelRole(role);
		}
		for (const [role, modelId] of Object.entries(roles)) {
			if (modelId) this.#setProfileOwnedModelRole(profile, role, modelId);
		}
	}

	#setProfileOwnedThinkingOverride(profile: string, value: string): void {
		if (!this.#profileOwnedThinkingOverride) {
			this.#profileOwnedThinkingOverride = {
				profile,
				hadPrevious: Object.hasOwn(this.#overrides, "defaultThinkingLevel"),
				previousValue: structuredClone(this.#overrides.defaultThinkingLevel),
			};
		}
		this.#overrides.defaultThinkingLevel = value;
	}

	#retireProfileOwnedThinkingOverride(): void {
		const owned = this.#profileOwnedThinkingOverride;
		if (!owned) return;
		if (owned.hadPrevious) this.#overrides.defaultThinkingLevel = structuredClone(owned.previousValue);
		else delete this.#overrides.defaultThinkingLevel;
		this.#profileOwnedThinkingOverride = undefined;
	}

	#supersedeProfileOwnedThinkingOverride(): void {
		this.#profileOwnedThinkingOverride = undefined;
	}

	#retireProfileRuntimeOverrides(): void {
		this.#retireAllProfileOwnedModelRoles();
		this.#retireProfileOwnedThinkingOverride();
		this.#profileRuntimeOwner = undefined;
	}

	#replaceProfileRuntimeOverrides(
		profile: string,
		snapshot: { modelRoles: Record<string, string>; defaultThinkingLevel: string },
	): void {
		this.#retireProfileRuntimeOverrides();
		this.#profileRuntimeOwner = profile;
		this.#replaceProfileOwnedModelRoles(profile, snapshot.modelRoles);
		this.#setProfileOwnedThinkingOverride(profile, snapshot.defaultThinkingLevel);
	}

	/**
	 * Reconcile only slots still carrying explicit profile provenance. Explicit
	 * runtime mutations remove that provenance, so unrelated disk reloads cannot
	 * infer ownership from equal values and overwrite them.
	 */
	#reconcileProfileRuntimeOverrides(nextGlobal: RawSettings, previousGlobal?: RawSettings): void {
		const active = getByPath(nextGlobal, ["profiles", "active"]);
		const items = getByPath(nextGlobal, ["profiles", "items"]);
		const snapshot =
			typeof active === "string" && active.length > 0 && isRecord(items)
				? this.#profileSnapshotFromUnknown(items[active])
				: undefined;
		if (!snapshot || typeof active !== "string") {
			this.#retireProfileRuntimeOverrides();
			return;
		}

		const liveSnapshot = {
			modelRoles: this.#modelRolesFromLayer(nextGlobal),
			defaultThinkingLevel:
				typeof getByPath(nextGlobal, ["defaultThinkingLevel"]) === "string"
					? (getByPath(nextGlobal, ["defaultThinkingLevel"]) as string)
					: snapshot.defaultThinkingLevel,
		};
		if (this.#profileRuntimeOwner !== active) {
			this.#replaceProfileRuntimeOverrides(active, liveSnapshot);
			return;
		}

		const previousActive = previousGlobal ? getByPath(previousGlobal, ["profiles", "active"]) : undefined;
		const previousRoles = previousGlobal ? this.#modelRolesFromLayer(previousGlobal) : {};
		const previousThinking = previousGlobal ? getByPath(previousGlobal, ["defaultThinkingLevel"]) : undefined;
		if (previousGlobal && previousActive === active) {
			for (const role of new Set([...Object.keys(previousRoles), ...Object.keys(liveSnapshot.modelRoles)])) {
				if (previousRoles[role] === liveSnapshot.modelRoles[role]) continue;
				// A public runtime override supersedes profile ownership for this slot.
				if (!this.#profileOwnedModelRoleOverrides.has(role)) continue;
				if (liveSnapshot.modelRoles[role] === undefined) this.#retireProfileOwnedModelRole(role);
				else this.#setProfileOwnedModelRole(active, role, liveSnapshot.modelRoles[role]);
			}
			if (
				previousThinking !== liveSnapshot.defaultThinkingLevel &&
				this.#profileOwnedThinkingOverride?.profile === active
			) {
				this.#setProfileOwnedThinkingOverride(active, liveSnapshot.defaultThinkingLevel);
			}
		}

		const runtimeRoles = this.#getRuntimeModelRoleOverrides();
		for (const role of [...this.#profileOwnedModelRoleOverrides.keys()]) {
			if (!Object.hasOwn(liveSnapshot.modelRoles, role)) this.#retireProfileOwnedModelRole(role);
		}
		for (const [role, modelId] of Object.entries(liveSnapshot.modelRoles)) {
			if (this.#profileOwnedModelRoleOverrides.has(role)) {
				runtimeRoles[role] = modelId;
			} else if (!Object.hasOwn(runtimeRoles, role)) {
				this.#setProfileOwnedModelRole(active, role, modelId);
			}
		}
		if (this.#profileOwnedThinkingOverride) {
			this.#overrides.defaultThinkingLevel = liveSnapshot.defaultThinkingLevel;
		}
	}

	/**
	 * Set the full `modelRoles` map on the runtime override layer without
	 * routing through the public {@link override} method. Internal callers
	 * (project edits, global fallback updates) use this so they can control
	 * capture invalidation independently of the whole-map replacement
	 * semantics that `override("modelRoles", …)` carries.
	 */
	#setRuntimeModelRoleOverrides(next: Record<string, string>): void {
		const prev = this.get("modelRoles");
		setByPath(this.#overrides, ["modelRoles"], next);
		this.#rebuildMerged();
		this.#fireEffectiveSettingChanged("modelRoles", this.get("modelRoles"), prev);
	}

	#updateRuntimeModelRoleOverride(role: ModelRole | string, modelId: string | undefined): void {
		const runtimeOverrides = getByPath(this.#overrides, ["modelRoles"]);
		if (!isRecord(runtimeOverrides) || !Object.hasOwn(runtimeOverrides, role)) return;

		const nextRuntimeOverride = this.#modelRolesFromLayer(this.#overrides);
		if (modelId === undefined) {
			delete nextRuntimeOverride[role];
		} else {
			nextRuntimeOverride[role] = modelId;
		}
		this.#setRuntimeModelRoleOverrides(nextRuntimeOverride);
	}

	/**
	 * Capture the original process-wide override for `role` the first time a
	 * project edit temporarily replaces it, so the original can be restored on
	 * cwd changes. Subsequent edits in the same cwd must not overwrite the
	 * first captured value.
	 */
	#captureRuntimeModelRoleOverride(role: ModelRole | string): void {
		if (this.#savedRuntimeModelRoleOverrides.has(role)) return;
		const runtimeOverrides = getByPath(this.#overrides, ["modelRoles"]);
		if (!isRecord(runtimeOverrides) || !Object.hasOwn(runtimeOverrides, role)) return;
		this.#savedRuntimeModelRoleOverrides.set(role, this.#modelRolesFromLayer(this.#overrides)[role]);
	}

	/**
	 * Restore original process-wide model-role overrides that were temporarily
	 * replaced by project edits, mutating `#overrides` in place without
	 * rebuilding. All remaining captures are valid because superseding
	 * operations (late `overrideModelRoles`, global-mode `setModelRole`,
	 * whole-map `override`/`clearOverride`) invalidate the affected captures
	 * at the point of supersession. Caller is responsible for `#rebuildMerged()`.
	 */
	#restoreRuntimeModelRoleOverrides(): void {
		if (this.#savedRuntimeModelRoleOverrides.size === 0) return;
		const runtimeRoles = getByPath(this.#overrides, ["modelRoles"]);
		if (!isRecord(runtimeRoles)) {
			this.#savedRuntimeModelRoleOverrides.clear();
			return;
		}
		for (const [role, originalValue] of this.#savedRuntimeModelRoleOverrides) {
			if (originalValue === undefined) {
				delete runtimeRoles[role];
			} else {
				runtimeRoles[role] = originalValue;
			}
		}
		this.#savedRuntimeModelRoleOverrides.clear();
	}

	/**
	 * Produce a deep copy of `#overrides` with original process-wide model-role
	 * overrides restored, for use by {@link cloneForCwd}. All remaining
	 * captures are valid (see {@link #restoreRuntimeModelRoleOverrides}).
	 * Does not mutate the current instance's `#overrides`.
	 */
	#buildOriginalOverrides(): RawSettings {
		const overrides = structuredClone(this.#overrides);
		const runtimeRoles = getByPath(overrides, ["modelRoles"]);
		if (isRecord(runtimeRoles)) {
			for (const [role, originalValue] of this.#savedRuntimeModelRoleOverrides) {
				if (originalValue === undefined) delete runtimeRoles[role];
				else runtimeRoles[role] = originalValue;
			}
			for (const [role, owned] of this.#profileOwnedModelRoleOverrides) {
				if (owned.hadPrevious) runtimeRoles[role] = structuredClone(owned.previousValue);
				else delete runtimeRoles[role];
			}
		}
		const thinking = this.#profileOwnedThinkingOverride;
		if (thinking) {
			if (thinking.hadPrevious) overrides.defaultThinkingLevel = structuredClone(thinking.previousValue);
			else delete overrides.defaultThinkingLevel;
		}
		return overrides;
	}

	#setProjectModelRoleValue(role: ModelRole | string, modelId: string | null): void {
		const prev = this.get("modelRoles");
		const projectRoles = getByPath(this.#project, ["modelRoles"]);
		const current: Record<string, unknown> = isRecord(projectRoles) ? { ...projectRoles } : {};
		current[role] = modelId;
		setByPath(this.#project, ["modelRoles"], current);
		this.#modifiedProjectModelRoles.add(role);
		this.#persistedMutationGeneration++;
		this.#rebuildMerged();
		this.#fireEffectiveSettingChanged("modelRoles", this.get("modelRoles"), prev);
		this.#queueProjectSave();
	}

	/**
	 * Set a model role (helper for modelRoles record). Passing `undefined`
	 * clears the role from the persisted record and any runtime override.
	 *
	 * In project storage mode, when a project edit has temporarily replaced
	 * the process-wide runtime override for `role` and that override is still
	 * active (the runtime slot currently matches the project value), the
	 * global-layer write must not rewrite that runtime slot — otherwise the
	 * global fallback would immediately shadow the still-configured project
	 * role. The global layer is still persisted; only the runtime override is
	 * left untouched. The guard is precise so that a later clear, a late
	 * `overrideModelRoles`, or a storage-mode transition does not leave a
	 * stale skip in place.
	 */
	setModelRole(role: ModelRole | string, modelId: string | undefined): void {
		const prev = this.get("modelRoles");
		const current = this.#modelRolesFromLayer(this.#global);
		if (modelId === undefined) delete current[role];
		else current[role] = modelId;
		setByPath(this.#global, ["modelRoles"], current);
		this.#modifiedGlobalModelRoles.add(role);
		this.#persistedMutationGeneration++;

		if (this.#profileRuntimeOwner) {
			this.#updateActiveProfileSnapshot({ modelRoles: current });
			if (modelId === undefined) {
				this.#supersedeProfileOwnedModelRole(role);
				const runtimeRoles = this.#getRuntimeModelRoleOverrides();
				delete runtimeRoles[role];
			} else {
				this.#setProfileOwnedModelRole(this.#profileRuntimeOwner, role, modelId);
			}
		} else if (!this.isProjectModelRoleRuntimeOverrideActive(role)) {
			this.#savedRuntimeModelRoleOverrides.delete(role);
			this.#updateRuntimeModelRoleOverride(role, modelId);
		}
		this.#rebuildMerged();
		this.#queueSave();
		this.#fireEffectiveSettingChanged("modelRoles", this.get("modelRoles"), prev);
	}

	/**
	 * Whether `role`'s runtime override slot currently holds the temporary
	 * project-scoped value installed by a prior `setProjectModelRole`. Returns
	 * `false` when storage is not project-mode, no capture exists, or the
	 * project role was cleared. With explicit provenance invalidation, a
	 * surviving capture implies no external supersession occurred.
	 */
	isProjectModelRoleRuntimeOverrideActive(role: ModelRole | string): boolean {
		if (this.get("modelRoleStorage") !== "project") return false;
		if (!this.#savedRuntimeModelRoleOverrides.has(role)) return false;
		return !!this.getProjectModelRole(role);
	}
	/**
	 * Set a model role in the current project's settings layer.
	 */
	setProjectModelRole(role: ModelRole | string, modelId: string): void {
		this.#supersedeProfileOwnedModelRole(role, true);
		this.#setProjectModelRoleValue(role, modelId);
		this.#captureRuntimeModelRoleOverride(role);
		this.#updateRuntimeModelRoleOverride(role, modelId);
	}
	/**
	 * Clear a model role from the current project's settings layer.
	 */
	clearProjectModelRole(role: ModelRole | string): void {
		this.#supersedeProfileOwnedModelRole(role, true);
		this.#setProjectModelRoleValue(role, null);
		this.#captureRuntimeModelRoleOverride(role);
		this.#updateRuntimeModelRoleOverride(role, undefined);
	}

	/**
	 * Get a model role (helper for modelRoles record).
	 */
	getModelRole(role: ModelRole | string): string | undefined {
		const roles: unknown = this.get("modelRoles");
		if (!isRecord(roles)) return undefined;
		return modelRoleValueFromUnknown(roles[role]);
	}
	/**
	 * Get a model role from only the global settings layer.
	 */
	getGlobalModelRole(role: ModelRole | string): string | undefined {
		const modelId = this.#modelRolesFromLayer(this.#global)[role];
		return modelId || undefined;
	}

	/**
	 * Get a model role from only the current project settings layer.
	 */
	getProjectModelRole(role: ModelRole | string): string | undefined {
		const modelId = this.#modelRolesFromLayer(this.#project)[role];
		return modelId || undefined;
	}

	/**
	 * Report which layer actually supplies the effective model role across
	 * full merge precedence (runtime override → config overlay → project →
	 * global → default). Unlike {@link getModelRoleSource}, this accounts
	 * for runtime and config-overlay layers and detects ownership by key
	 * presence rather than normalized value, so a `null` tombstone in the
	 * overlay or runtime layer correctly blocks lower layers. The project
	 * layer is checked through {@link #projectSettingsForMerge} because a
	 * project null is a cleared value (falls back to global), not a
	 * tombstone.
	 */
	getModelRoleProvenance(role: ModelRole | string): "runtime" | "overlay" | "project" | "global" | "default" {
		if (this.#modelRoleLayerOwns(this.#overrides, role)) return "runtime";
		if (this.#modelRoleLayerOwns(this.#configOverlay, role)) return "overlay";
		if (this.#modelRoleLayerOwns(this.#projectSettingsForMerge(), role)) return "project";
		if (this.#modelRoleLayerOwns(this.#global, role)) return "global";
		return "default";
	}

	/**
	 * Get the persisted layer supplying a model role (project/global/default only).
	 */
	getModelRoleSource(role: ModelRole | string): "project" | "global" | "default" {
		if (this.getProjectModelRole(role)) return "project";
		if (this.getGlobalModelRole(role)) return "global";
		return "default";
	}

	/**
	 * Get all model roles (helper for modelRoles record).
	 */
	getModelRoles(): ReadOnlyDict<string> {
		const roles: unknown = this.get("modelRoles");
		if (!isRecord(roles)) return {};

		const normalized: Record<string, string> = {};
		for (const role in roles) {
			if (!Object.hasOwn(roles, role)) continue;
			const modelId = modelRoleValueFromUnknown(roles[role]);
			if (modelId !== undefined) {
				normalized[role] = modelId;
			}
		}
		return normalized;
	}

	/*
	 * Override model roles (helper for modelRoles record).
	 */
	overrideModelRoles(roles: ReadOnlyDict<string>): void {
		const next = this.#modelRolesFromLayer(this.#overrides);
		for (const [role, modelId] of Object.entries(roles)) {
			if (modelId) {
				next[role] = modelId;
				this.#supersedeProfileOwnedModelRole(role);
				this.#savedRuntimeModelRoleOverrides.delete(role);
			}
		}
		this.#setRuntimeModelRoleOverrides(next);
	}

	/**
	 * Set disabled providers (for compatibility with discovery system).
	 */
	setDisabledProviders(ids: string[]): void {
		this.set("disabledProviders", ids);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Loading
	// ─────────────────────────────────────────────────────────────────────────

	async #load(): Promise<Settings> {
		// Project settings discovery is independent of the persist chain, while
		// the persist steps themselves remain sequential. Wait for both branches
		// to settle so simultaneous failures produce one catchable error without
		// abandoning the other rejection.
		const [globalResult, projectResult] = await Promise.allSettled([
			this.#persist ? this.#loadGlobalSettings() : Promise.resolve(),
			this.#loadProjectSettings(),
		]);
		if (globalResult.status === "rejected") throw globalResult.reason;
		if (projectResult.status === "rejected") throw projectResult.reason;

		this.#project = projectResult.value;
		this.#configOverlay = await this.#loadConfigOverlays();
		this.#reconcileProfileRuntimeOverrides(this.#global);

		// Build merged view (global → project → overrides; project wins over global)
		this.#rebuildMerged();
		this.#fireAllHooks();
		this.#startGlobalSettingsWatch();
		return this;
	}
	async #loadGlobalSettings(): Promise<void> {
		this.#storage = await AgentStorage.open(getAgentDbPath(this.#agentDir));
		const existingConfig = await this.#loadExistingMainYaml();
		if (existingConfig) {
			this.#global = existingConfig;
		} else {
			await this.#migrateFromLegacy();
			this.#global = await this.#loadYaml(this.#configPath!);
		}
		await this.#seedLastChangelogVersionMarker();
	}

	async #loadReadOnly(): Promise<Settings> {
		const [globalResult, projectResult] = await Promise.allSettled([
			this.#loadExistingMainYaml(),
			this.#loadProjectSettings(),
		]);
		if (globalResult.status === "rejected") throw globalResult.reason;
		if (projectResult.status === "rejected") throw projectResult.reason;
		if (globalResult.value) {
			this.#global = globalResult.value;
		}

		this.#project = projectResult.value;
		this.#configOverlay = await this.#loadConfigOverlays();
		this.#reconcileProfileRuntimeOverrides(this.#global);
		this.#rebuildMerged();
		return this;
	}

	async #loadYaml(filePath: string): Promise<RawSettings> {
		const loaded = await this.#loadYamlIfPresentForStartup(filePath);
		return loaded ?? {};
	}

	async #loadYamlIfPresent(filePath: string, captureLegacyChangelogVersion = true): Promise<YamlLoadResult> {
		let content: string;
		try {
			content = await fs.promises.readFile(filePath, "utf8");
		} catch (error) {
			if (isEnoent(error)) return { kind: "missing" };
			return { kind: "unreadable", error };
		}

		let parsed: unknown;
		try {
			parsed = YAML.parse(content);
		} catch (error) {
			return { kind: "invalid", error };
		}
		if (parsed === null || parsed === undefined) {
			return { kind: "loaded", settings: {} };
		}
		if (typeof parsed !== "object" || Array.isArray(parsed)) {
			return {
				kind: "invalid",
				error: new Error("Settings YAML must contain a mapping at the document root"),
			};
		}
		return {
			kind: "loaded",
			settings: this.#migrateRawSettings(parsed as RawSettings, captureLegacyChangelogVersion),
		};
	}

	async #resolveYamlWritePath(filePath: string): Promise<string> {
		const quarantinedTarget = this.#quarantinedYamlTargets.get(filePath);
		if (quarantinedTarget) return quarantinedTarget;
		try {
			return await fs.promises.realpath(filePath);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}

		// realpath fails for a dangling symlink. Resolve its immediate target so
		// recreating a quarantined config repairs the target without replacing
		// the user-managed link.
		try {
			const stat = await fs.promises.lstat(filePath);
			if (stat.isSymbolicLink()) {
				const target = await fs.promises.readlink(filePath);
				return path.resolve(path.dirname(filePath), target);
			}
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		return path.resolve(filePath);
	}

	async #withYamlWriteLock<T>(filePath: string, fn: (writePath: string) => Promise<T>): Promise<T> {
		const writePath = await this.#resolveYamlWritePath(filePath);
		return await withFileLock(writePath, async () => fn(writePath));
	}

	async #loadYamlIfPresentForStartup(filePath: string): Promise<RawSettings | null> {
		const result = await this.#loadYamlIfPresent(filePath);
		if (result.kind !== "invalid" || !this.#persist) {
			return this.#unwrapYamlLoadResult(filePath, result);
		}
		return await this.#withYamlWriteLock(filePath, async writePath =>
			this.#loadYamlIfPresentForWriteLocked(filePath, writePath, true),
		);
	}

	/**
	 * Read a YAML settings file while its write lock is held. Invalid files are
	 * moved aside before reporting failure, so a later write can never truncate
	 * the only copy of the user's configuration.
	 */
	async #loadYamlIfPresentForWriteLocked(
		filePath: string,
		writePath: string,
		rejectMissing = false,
	): Promise<RawSettings | null> {
		let result = await this.#loadYamlIfPresent(writePath);
		if (result.kind === "missing" && rejectMissing) {
			throw new Error(
				`Settings config was invalid before locking and is now missing: ${filePath}; another process may have moved it aside`,
			);
		}
		if (result.kind === "invalid") {
			result = await this.#quarantineInvalidYamlLocked(writePath, result);
			this.#quarantinedYamlTargets.set(filePath, writePath);
		}
		return this.#unwrapYamlLoadResult(filePath, result);
	}

	async #quarantineInvalidYamlLocked(
		filePath: string,
		result: Extract<YamlLoadResult, { kind: "invalid" }>,
	): Promise<Extract<YamlLoadResult, { kind: "invalid" }>> {
		const backupPath = `${filePath}.broken-${Date.now()}-${process.pid}-${randomUUID()}`;
		try {
			await fs.promises.rename(filePath, backupPath);
		} catch (error) {
			throw new Error(
				`Settings config is invalid and could not be moved aside: ${filePath}; refusing to overwrite it: ${String(error)}`,
			);
		}
		logger.warn("Settings: moved invalid config aside", {
			path: filePath,
			backupPath,
			error: String(result.error),
		});
		return { ...result, backupPath };
	}

	#unwrapYamlLoadResult(filePath: string, result: YamlLoadResult): RawSettings | null {
		switch (result.kind) {
			case "missing":
				return null;
			case "loaded":
				return result.settings;
			case "invalid":
				throw new Error(
					`Settings config is invalid: ${filePath}${result.backupPath ? ` (moved to ${result.backupPath})` : ""}: ${String(result.error)}`,
				);
			case "unreadable":
				throw new Error(`Failed to read settings config ${filePath}: ${String(result.error)}`);
		}
	}

	async #readExistingMainYaml(quarantineInvalid: boolean): Promise<MainYamlReadResult> {
		if (!this.#configPath) return { settings: null, configPath: null };
		for (const filename of MAIN_CONFIG_FILENAMES) {
			const configPath = path.join(this.#agentDir, filename);
			const loaded = quarantineInvalid
				? await this.#loadYamlIfPresentForStartup(configPath)
				: this.#unwrapYamlLoadResult(configPath, await this.#loadYamlIfPresent(configPath, false));
			if (loaded) return { settings: loaded, configPath };
		}
		return {
			settings: null,
			configPath: path.join(this.#agentDir, MAIN_CONFIG_FILENAMES[0]),
		};
	}

	async #loadExistingMainYaml(): Promise<RawSettings | null> {
		const result = await this.#readExistingMainYaml(true);
		this.#configPath = result.configPath;
		return result.settings;
	}

	async #readProjectSettings(quarantineInvalid: boolean): Promise<ProjectSettingsReadResult> {
		let shellPathSource: string | undefined;
		let merged: RawSettings = {};
		try {
			const result = await loadCapability(settingsCapability.id, { cwd: this.#cwd });
			for (const item of result.items as SettingsCapabilityItem[]) {
				if (item.level === "project") {
					merged = this.#deepMerge(merged, item.data as RawSettings);
					if (Object.hasOwn(item.data, "shellPath")) shellPathSource = item.path;
				}
			}
		} catch {
			shellPathSource = undefined;
			// Capability discovery is best-effort; the native project config below
			// remains authoritative for its model-role layer and must not be hidden.
		}
		const projectConfigPath = path.join(this.#cwd, ".omp", "config.yml");
		const nativeProject = quarantineInvalid
			? await this.#loadYaml(projectConfigPath)
			: (this.#unwrapYamlLoadResult(projectConfigPath, await this.#loadYamlIfPresent(projectConfigPath, false)) ??
				{});
		const nativeModelRoles = getByPath(nativeProject, ["modelRoles"]);
		if (nativeModelRoles !== undefined) {
			merged = this.#deepMerge(merged, { modelRoles: nativeModelRoles });
		}
		return {
			settings: this.#migrateRawSettings(merged, quarantineInvalid),
			fileSettings: structuredClone(nativeProject),
			shellPathSource,
		};
	}

	async #loadProjectSettings(): Promise<RawSettings> {
		const result = await this.#readProjectSettings(true);
		this.#projectFileSettings = result.fileSettings;
		this.#projectShellPathSource = result.shellPathSource;
		return result.settings;
	}

	async #readConfigOverlays(captureLegacyChangelogVersion = true): Promise<ConfigOverlayReadResult> {
		let shellPathSource: string | undefined;
		let settings: RawSettings = {};
		for (const filePath of this.#configFiles) {
			const overlay = await this.#loadOverlayYaml(filePath, captureLegacyChangelogVersion);
			settings = this.#deepMerge(settings, overlay);
			if (Object.hasOwn(overlay, "shellPath")) shellPathSource = filePath;
		}
		return { settings, shellPathSource };
	}

	async #loadConfigOverlays(): Promise<RawSettings> {
		const result = await this.#readConfigOverlays();
		this.#overlayShellPathSource = result.shellPathSource;
		return result.settings;
	}

	/**
	 * Strict loader for explicit `--config` overlays: unlike `#loadYaml`,
	 * missing or malformed files are hard errors so a typo'd path cannot
	 * silently fall back to the persistent settings.
	 */
	async #loadOverlayYaml(filePath: string, captureLegacyChangelogVersion = true): Promise<RawSettings> {
		let content: string;
		try {
			content = await Bun.file(filePath).text();
		} catch (error) {
			throw new Error(
				isEnoent(error)
					? `Config overlay not found: ${filePath}`
					: `Failed to read config overlay ${filePath}: ${String(error)}`,
			);
		}
		let parsed: unknown;
		try {
			parsed = YAML.parse(content);
		} catch (error) {
			throw new Error(`Failed to parse config overlay ${filePath}: ${String(error)}`);
		}
		if (parsed === null || parsed === undefined) return {};
		if (typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`Config overlay must be a YAML mapping: ${filePath}`);
		}
		return this.#migrateRawSettings(parsed as RawSettings, captureLegacyChangelogVersion);
	}

	async #migrateFromLegacy(): Promise<void> {
		if (!this.#configPath) return;

		let settings: RawSettings = {};
		let migrated = false;

		// 1. Migrate from settings.json
		const settingsJsonPath = path.join(this.#agentDir, "settings.json");
		try {
			const parsed: unknown = JSONC.parse(await Bun.file(settingsJsonPath).text());
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				settings = this.#deepMerge(settings, this.#migrateRawSettings(parsed as RawSettings));
				migrated = true;
				try {
					fs.renameSync(settingsJsonPath, `${settingsJsonPath}.bak`);
				} catch {}
			}
		} catch {}

		// 2. Migrate from agent.db
		try {
			const dbSettings = this.#storage?.getSettings();
			if (dbSettings) {
				settings = this.#deepMerge(settings, this.#migrateRawSettings(dbSettings as RawSettings));
				migrated = true;
			}
		} catch {}

		// 3. Write merged settings
		if (migrated && Object.keys(settings).length > 0) {
			try {
				await this.#writeYamlAtomically(this.#configPath, settings);
				logger.debug("Settings: migrated to config.yml", { path: this.#configPath });
			} catch {}
		}
	}

	/** Apply schema migrations to raw settings */
	#migrateRawSettings(raw: RawSettings, captureLegacyChangelogVersion = true): RawSettings {
		// queueMode -> steeringMode
		if ("queueMode" in raw && !("steeringMode" in raw)) {
			raw.steeringMode = raw.queueMode;
			delete raw.queueMode;
		}

		// lastChangelogVersion moved out of config.yml into the
		// <agentDir>/last-changelog-version marker file so version bumps no
		// longer dirty user-tracked configs. Capture for marker seeding (see
		// #seedLastChangelogVersionMarker), then strip the key — the next
		// config save drops it from disk.
		if (captureLegacyChangelogVersion && typeof raw.lastChangelogVersion === "string") {
			this.#legacyLastChangelogVersion ??= raw.lastChangelogVersion;
		}
		delete raw.lastChangelogVersion;

		// collapseChangelog (boolean) -> startup.changelogMode (enum). Preserve
		// every explicit legacy choice while giving new installs the schema's
		// "summary" default: true -> summary, false -> expanded. A separately
		// configured new mode always wins.
		const startupObj = isRecord(raw.startup) ? (raw.startup as Record<string, unknown>) : undefined;
		const legacyCollapseChangelog = typeof raw.collapseChangelog === "boolean" ? raw.collapseChangelog : undefined;
		const flatChangelogMode = raw["startup.changelogMode"];
		const normalizedFlatChangelogMode =
			flatChangelogMode === "summary" || flatChangelogMode === "expanded" || flatChangelogMode === "hidden"
				? flatChangelogMode
				: undefined;
		if (legacyCollapseChangelog !== undefined || normalizedFlatChangelogMode !== undefined) {
			if (!startupObj) {
				raw.startup = {};
			}
			const target = raw.startup as Record<string, unknown>;
			if (target.changelogMode === undefined) {
				target.changelogMode =
					normalizedFlatChangelogMode ??
					(legacyCollapseChangelog !== undefined ? (legacyCollapseChangelog ? "summary" : "expanded") : undefined);
			}
		}
		delete raw.collapseChangelog;
		delete raw["startup.changelogMode"];

		// ask.timeout: ms -> seconds (if value > 1000, it's old ms format)
		if (raw.ask && typeof (raw.ask as Record<string, unknown>).timeout === "number") {
			const oldValue = (raw.ask as Record<string, unknown>).timeout as number;
			if (oldValue > 1000) {
				(raw.ask as Record<string, unknown>).timeout = Math.round(oldValue / 1000);
			}
		}

		// Migrate old flat "theme" string to nested theme.dark/theme.light
		if (typeof raw.theme === "string") {
			const oldTheme = raw.theme;
			if (oldTheme === "light" || oldTheme === "dark") {
				// Built-in defaults — just remove, let new defaults apply
				delete raw.theme;
			} else {
				// Custom theme — detect luminance to place in correct slot
				const slot = isLightTheme(oldTheme) ? "light" : "dark";
				raw.theme = { [slot]: oldTheme };
			}
		}

		// inspect_image.enabled (boolean) -> inspect_image.mode (enum). Explicit
		// user choices are preserved: true -> "on", false -> "off". Configs with
		// no legacy key get the new "auto" default, which hides the tool for
		// models with native image input. Handles nested and quoted-dotted
		// ("inspect_image.enabled") sources; the target is always the nested
		// form, which is the only shape the resolver reads.
		const inspectImageObj = isRecord(raw.inspect_image) ? (raw.inspect_image as Record<string, unknown>) : undefined;
		const legacyEnabled =
			typeof inspectImageObj?.enabled === "boolean"
				? inspectImageObj.enabled
				: typeof raw["inspect_image.enabled"] === "boolean"
					? (raw["inspect_image.enabled"] as boolean)
					: undefined;
		if (legacyEnabled !== undefined) {
			if (!inspectImageObj) {
				raw.inspect_image = {};
			}
			const target = raw.inspect_image as Record<string, unknown>;
			const flatMode = raw["inspect_image.mode"];
			if (target.mode === undefined) {
				// A quoted-dotted explicit mode wins over the legacy boolean but
				// must be normalized into the nested form the resolver reads.
				target.mode =
					typeof flatMode === "string" && (INSPECT_IMAGE_MODES as readonly string[]).includes(flatMode)
						? flatMode
						: legacyEnabled
							? "on"
							: "off";
			}
			delete target.enabled;
			delete raw["inspect_image.enabled"];
			delete raw["inspect_image.mode"];
		}

		// task.isolation.enabled (boolean) -> task.isolation.mode (enum)
		const taskObj = raw.task as Record<string, unknown> | undefined;
		const isolationObj = taskObj?.isolation as Record<string, unknown> | undefined;
		if (isolationObj && "enabled" in isolationObj) {
			if (typeof isolationObj.enabled === "boolean") {
				isolationObj.mode = isolationObj.enabled ? "auto" : "none";
			}
			delete isolationObj.enabled;
		}

		// task.simple: removed — the task tool no longer accepts a per-call
		// schema (workflows drive structured output via eval agent()) and the
		// batch/context shape is gated by task.batch instead.
		if (taskObj && "simple" in taskObj) {
			delete taskObj.simple;
		}

		// task.eager / todo.eager: boolean -> enum (default | preferred | always).
		// `true` reproduced the previous "on" behavior, which is now `always`.
		if (taskObj && typeof taskObj.eager === "boolean") {
			taskObj.eager = taskObj.eager ? "always" : "default";
		}
		const todoObj = raw.todo as Record<string, unknown> | undefined;
		if (todoObj && typeof todoObj.eager === "boolean") {
			todoObj.eager = todoObj.eager ? "always" : "default";
		}

		// task.isolation.mode: legacy values from before the pi-iso PAL refactor.
		// `worktree` was git worktree → now lives under `rcopy`. `fuse-overlay`
		// and `fuse-projfs` are now the platform-named `overlayfs` / `projfs`
		// kinds; the PAL falls back internally when the chosen one isn't
		// available, so we don't need the old TS-side platform guards.
		if (isolationObj && typeof isolationObj.mode === "string") {
			const legacy: Record<string, string> = {
				worktree: "rcopy",
				"fuse-overlay": "overlayfs",
				"fuse-projfs": "projfs",
			};
			const mapped = legacy[isolationObj.mode as string];
			if (mapped !== undefined) {
				isolationObj.mode = mapped;
			}
		}

		// edit.mode: removed "atom" and "vim" variants map back to "hashline"
		const editObj = raw.edit as Record<string, unknown> | undefined;
		if (editObj) {
			if (editObj.mode === "atom" || editObj.mode === "vim") {
				editObj.mode = "hashline";
			}
			const modelVariants = editObj.modelVariants as Record<string, unknown> | undefined;
			if (modelVariants && typeof modelVariants === "object" && !Array.isArray(modelVariants)) {
				for (const [pattern, variant] of Object.entries(modelVariants)) {
					if (variant === "atom" || variant === "vim") {
						modelVariants[pattern] = "hashline";
					}
				}
			}
		}
		if (raw["edit.mode"] === "atom" || raw["edit.mode"] === "vim") {
			raw["edit.mode"] = "hashline";
		}

		// compaction.strategy / compaction.remoteEnabled → compaction.methodOrder.
		// The old single strategy could not express a capability-dependent fallback
		// chain. Preserve explicit legacy intent while new installs use the
		// server → snapcompact → handoff → shake → soft default.
		const compactionObj = isRecord(raw.compaction) ? raw.compaction : undefined;
		const configuredMethodOrder = compactionObj?.methodOrder ?? raw["compaction.methodOrder"];
		const legacyStrategy = compactionObj?.strategy ?? raw["compaction.strategy"];
		const legacyRemoteEnabled = compactionObj?.remoteEnabled ?? raw["compaction.remoteEnabled"];
		if (!Array.isArray(configuredMethodOrder)) {
			const remoteEnabled = legacyRemoteEnabled !== false;
			const strategy = legacyStrategy === "shake-summary" ? "shake" : legacyStrategy;
			let methodOrder: CompactionMethod[] | undefined;
			switch (strategy) {
				case "context-full":
					methodOrder = remoteEnabled ? ["remote", "soft"] : ["soft"];
					break;
				case "handoff":
					methodOrder = remoteEnabled ? ["handoff", "remote", "soft"] : ["handoff", "soft"];
					break;
				case "shake":
					methodOrder = remoteEnabled ? ["shake", "remote", "soft"] : ["shake", "soft"];
					break;
				case "snapcompact":
					methodOrder = remoteEnabled ? ["snapcompact", "remote", "soft"] : ["snapcompact", "soft"];
					break;
				case "off":
					methodOrder = [];
					break;
				default:
					if (legacyRemoteEnabled === false) {
						methodOrder = DEFAULT_COMPACTION_METHOD_ORDER.filter(method => method !== "remote");
					}
			}
			if (methodOrder) {
				const root = compactionObj ?? {};
				root.methodOrder = methodOrder;
				raw.compaction = root;
			}
		} else if (!compactionObj || compactionObj.methodOrder === undefined) {
			const root = compactionObj ?? {};
			root.methodOrder = configuredMethodOrder;
			raw.compaction = root;
		}
		if (compactionObj) {
			delete compactionObj.strategy;
			delete compactionObj.remoteEnabled;
		}
		delete raw["compaction.strategy"];
		delete raw["compaction.remoteEnabled"];
		delete raw["compaction.methodOrder"];

		// snapcompact.systemPrompt: boolean -> scoped enum.
		const snapcompactObj = raw.snapcompact as Record<string, unknown> | undefined;
		if (snapcompactObj && typeof snapcompactObj.systemPrompt === "boolean") {
			snapcompactObj.systemPrompt = snapcompactObj.systemPrompt ? "all" : "none";
		}
		if (typeof raw["snapcompact.systemPrompt"] === "boolean") {
			raw["snapcompact.systemPrompt"] = raw["snapcompact.systemPrompt"] ? "all" : "none";
		}

		// inlineToolDescriptors: boolean -> enum (auto | on | off). The old
		// `true`/`false` mapped directly onto inline-on/inline-off, so preserve
		// the user's explicit choice; new installs get the `auto` default that
		// turns it on only for Gemini models.
		if (typeof raw.inlineToolDescriptors === "boolean") {
			raw.inlineToolDescriptors = raw.inlineToolDescriptors ? "on" : "off";
		}

		// statusLine: rename "plan_mode" segment to "mode"
		const statusLineObj = raw.statusLine as Record<string, unknown> | undefined;
		if (statusLineObj) {
			for (const key of ["leftSegments", "rightSegments"] as const) {
				const segments = statusLineObj[key];
				if (Array.isArray(segments)) {
					statusLineObj[key] = segments.map(seg => (seg === "plan_mode" ? "mode" : seg));
				}
			}
			const segmentOptions = statusLineObj.segmentOptions as Record<string, unknown> | undefined;
			if (segmentOptions && "plan_mode" in segmentOptions && !("mode" in segmentOptions)) {
				segmentOptions.mode = segmentOptions.plan_mode;
				delete segmentOptions.plan_mode;
			}
		}

		// providers.parallelFetch (boolean) replaced by the providers.fetch reader
		// priority enum. The new default ("auto") supersedes both old values —
		// Parallel is now a deep fallback in the auto chain rather than the first
		// choice — so drop the legacy key (flat and nested) and let the enum
		// default apply.
		const providersObj = raw.providers as Record<string, unknown> | undefined;
		if (providersObj && "parallelFetch" in providersObj) {
			delete providersObj.parallelFetch;
		}
		delete raw["providers.parallelFetch"];

		// codexResets.autoRedeem: boolean -> tri-state enum.
		// Existing explicit false keeps the old "do not run" behavior; missing
		// config now falls through to the new "unset" default, which asks before
		// the first eligible spend.
		const codexResetsObj = raw.codexResets as Record<string, unknown> | undefined;
		if (codexResetsObj && typeof codexResetsObj.autoRedeem === "boolean") {
			codexResetsObj.autoRedeem = codexResetsObj.autoRedeem ? "yes" : "no";
		}
		if (typeof raw["codexResets.autoRedeem"] === "boolean") {
			raw["codexResets.autoRedeem"] = raw["codexResets.autoRedeem"] ? "yes" : "no";
		}

		// Map legacy `memories.enabled` boolean to the explicit `memory.backend`
		// enum if the latter hasn't been set yet. Idempotent: subsequent
		// migrations are no-ops once memory.backend is materialised.
		const memoryBackendObj = raw.memory as Record<string, unknown> | undefined;
		const memoryBackendSet = memoryBackendObj && typeof memoryBackendObj.backend === "string";
		const memoriesObj = raw.memories as Record<string, unknown> | undefined;
		if (!memoryBackendSet && memoriesObj && typeof memoriesObj.enabled === "boolean") {
			const next = memoriesObj.enabled ? "local" : "off";
			const memoryRoot = (memoryBackendObj ?? {}) as Record<string, unknown>;
			memoryRoot.backend = next;
			raw.memory = memoryRoot;
		}

		// Rename the legacy local `mnemosyne` memory backend to `mnemopi`.
		// - `memory.backend: "mnemosyne"` now selects the renamed backend.
		// - the top-level `mnemosyne` settings object becomes `mnemopi`.
		// Idempotent: skips the object move once `mnemopi` is materialised.
		if (memoryBackendObj && memoryBackendObj.backend === "mnemosyne") {
			memoryBackendObj.backend = "mnemopi";
		}
		if ("mnemosyne" in raw && !("mnemopi" in raw)) {
			raw.mnemopi = raw.mnemosyne;
			delete raw.mnemosyne;
		}

		// hindsight: dynamicBankId/agentName -> scoping enum + bankId
		// - dynamicBankId=true  → scoping="per-project" (closest semantic match;
		//   the legacy `agent::project::channel::user` tuple was per-project in
		//   practice — the channel/user env vars were rarely set).
		// - hindsight.agentName was only used as the agent slot in the legacy
		//   dynamic tuple; if the user customised it we surface it as the new
		//   bankId base when no explicit bankId is set.
		const hindsightObj = raw.hindsight as Record<string, unknown> | undefined;
		if (hindsightObj) {
			if ("dynamicBankId" in hindsightObj) {
				if (!("scoping" in hindsightObj) && hindsightObj.dynamicBankId === true) {
					hindsightObj.scoping = "per-project";
				}
				delete hindsightObj.dynamicBankId;
			}
			if ("agentName" in hindsightObj) {
				const agentName = hindsightObj.agentName;
				if (
					!("bankId" in hindsightObj) &&
					typeof agentName === "string" &&
					agentName.trim().length > 0 &&
					agentName !== "omp"
				) {
					hindsightObj.bankId = agentName;
				}
				delete hindsightObj.agentName;
			}
		}

		// power.preventIdleSleep / power.preventSystemSleep / power.declareUserActive
		// / power.preventDisplaySleep (four booleans) → power.sleepPrevention enum.
		// The enum is cumulative: each level adds the flags of all lower levels.
		// Migration picks the highest level whose condition is met, scanning from
		// most to least aggressive so a single enum value captures the old state.
		if (
			!("sleepPrevention" in ((raw.power as Record<string, unknown>) ?? {})) &&
			raw["power.sleepPrevention"] === undefined
		) {
			const powerObj = raw.power as Record<string, unknown> | undefined;
			const getFlag = (key: string): boolean | undefined => {
				const nested = powerObj?.[key];
				const flat = raw[`power.${key}`];
				const value = nested ?? flat;
				return typeof value === "boolean" ? value : undefined;
			};
			const idle = getFlag("preventIdleSleep");
			const system = getFlag("preventSystemSleep");
			const user = getFlag("declareUserActive");
			const display = getFlag("preventDisplaySleep");
			const anySet = idle !== undefined || system !== undefined || user !== undefined || display !== undefined;
			if (anySet) {
				const mode = system || user ? "system" : display ? "display" : idle !== false ? "idle" : "off";
				const powerRoot = (powerObj ?? {}) as Record<string, unknown>;
				powerRoot.sleepPrevention = mode;
				raw.power = powerRoot;
			}
			// Clean up old keys (nested + flat)
			if (powerObj) {
				delete powerObj.preventIdleSleep;
				delete powerObj.preventSystemSleep;
				delete powerObj.declareUserActive;
				delete powerObj.preventDisplaySleep;
			}
			delete raw["power.preventIdleSleep"];
			delete raw["power.preventSystemSleep"];
			delete raw["power.declareUserActive"];
			delete raw["power.preventDisplaySleep"];
		}

		// Migration for renamed settings grep.* and glob.* from search.* and find.*:
		// 1. Nested settings: find -> glob, search -> grep (per-property merge to avoid clobbering)
		const ensureRawObject = (key: "glob" | "grep"): Record<string, unknown> => {
			const current = raw[key];
			if (isRecord(current)) {
				return current;
			}
			const created: Record<string, unknown> = {};
			raw[key] = created;
			return created;
		};

		if ("find" in raw) {
			const findObj = raw.find;
			if (isRecord(findObj)) {
				const globObj = ensureRawObject("glob");
				const findKeys: Array<"enabled"> = ["enabled"];
				for (const key of findKeys) {
					if (key in findObj && !(key in globObj)) {
						globObj[key] = findObj[key];
					}
				}
			}
			delete raw.find;
		}

		if ("search" in raw) {
			const searchObj = raw.search;
			if (isRecord(searchObj)) {
				const grepObj = ensureRawObject("grep");
				const searchKeys: Array<"enabled" | "contextBefore" | "contextAfter"> = [
					"enabled",
					"contextBefore",
					"contextAfter",
				];
				for (const key of searchKeys) {
					if (key in searchObj && !(key in grepObj)) {
						grepObj[key] = searchObj[key];
					}
				}
			}
			delete raw.search;
		}

		// 2. Flat settings keys: map them to the proper nested target so get/set resolves them correctly
		if ("find.enabled" in raw) {
			const globObj = ensureRawObject("glob");
			if (!("enabled" in globObj)) {
				globObj.enabled = raw["find.enabled"];
			}
			delete raw["find.enabled"];
		}
		if ("search.enabled" in raw) {
			const grepObj = ensureRawObject("grep");
			if (!("enabled" in grepObj)) {
				grepObj.enabled = raw["search.enabled"];
			}
			delete raw["search.enabled"];
		}
		if ("search.contextBefore" in raw) {
			const grepObj = ensureRawObject("grep");
			if (!("contextBefore" in grepObj)) {
				grepObj.contextBefore = raw["search.contextBefore"];
			}
			delete raw["search.contextBefore"];
		}
		if ("search.contextAfter" in raw) {
			const grepObj = ensureRawObject("grep");
			if (!("contextAfter" in grepObj)) {
				grepObj.contextAfter = raw["search.contextAfter"];
			}
			delete raw["search.contextAfter"];
		}

		// Also clean up any empty nested objects we might have created or left behind
		if (raw.glob && typeof raw.glob === "object" && Object.keys(raw.glob).length === 0) {
			delete raw.glob;
		}
		if (raw.grep && typeof raw.grep === "object" && Object.keys(raw.grep).length === 0) {
			delete raw.grep;
		}
		// readHashLines: removed. Hashline anchors are now driven solely by
		// edit.mode === "hashline"; the separate read toggle only ever produced
		// the incoherent "hashline edits without addressable anchors" state.
		delete raw.readHashLines;

		// serviceTier (single enum with scoped openai-only/claude-only sentinels)
		// → per-family tier.openai/tier.anthropic/tier.google; serviceTierSubagent
		// → tier.subagent; serviceTierAdvisor → tier.advisor. `fastModeScope` is
		// dropped — per-family scoping is now expressed by the three tier settings.
		const tierObj = isRecord(raw.tier) ? raw.tier : {};
		let tierTouched = false;
		const setTier = (family: string, value: unknown): void => {
			if (value !== undefined && !(family in tierObj)) {
				tierObj[family] = value;
				tierTouched = true;
			}
		};
		if (typeof raw.serviceTier === "string") {
			switch (raw.serviceTier) {
				case "priority":
					setTier("openai", "priority");
					setTier("anthropic", "priority");
					setTier("google", "priority");
					break;
				case "openai-only":
					setTier("openai", "priority");
					break;
				case "claude-only":
					setTier("anthropic", "priority");
					break;
				case "auto":
				case "default":
				case "flex":
				case "scale":
					setTier("openai", raw.serviceTier);
					break;
			}
			delete raw.serviceTier;
		}
		const mapInheritTier = (value: unknown): unknown =>
			value === "openai-only" || value === "claude-only" ? "priority" : value;
		if ("serviceTierSubagent" in raw) {
			setTier("subagent", mapInheritTier(raw.serviceTierSubagent));
			delete raw.serviceTierSubagent;
		}
		if ("serviceTierAdvisor" in raw) {
			setTier("advisor", mapInheritTier(raw.serviceTierAdvisor));
			delete raw.serviceTierAdvisor;
		}
		if (tierTouched) raw.tier = tierObj;
		delete raw.fastModeScope;

		// advisor.subagents (blanket advisor on every spawned subagent) → per-agent
		// task.agentAdvisor, migrated to the bundled generic `task` agent. An
		// explicit boolean maps to "on"/"off" IN THE SAME LAYER — migration runs
		// per file, so a project-level `false` must keep overriding a global
		// `true` after both layers migrate.
		{
			const advisorObj = isRecord(raw.advisor) ? raw.advisor : undefined;
			const legacySubagents =
				advisorObj && "subagents" in advisorObj ? advisorObj.subagents : raw["advisor.subagents"];
			if (typeof legacySubagents === "boolean") {
				const taskObj = isRecord(raw.task) ? raw.task : {};
				const agentAdvisor = isRecord(taskObj.agentAdvisor) ? taskObj.agentAdvisor : {};
				if (!("task" in agentAdvisor)) agentAdvisor.task = legacySubagents ? "on" : "off";
				taskObj.agentAdvisor = agentAdvisor;
				raw.task = taskObj;
			}
			if (advisorObj) delete advisorObj.subagents;
			delete raw["advisor.subagents"];
		}

		// v17 renames that used to nest under a boolean parent path:
		//   dev.autoqa.consent -> dev.autoqaConsent
		//   todo.reminders.max -> todo.remindersMax
		migrateNestedLeafRename(
			raw,
			"dev",
			"autoqa",
			"consent",
			"autoqaConsent",
			value => value === "unset" || value === "granted" || value === "denied",
		);
		migrateNestedLeafRename(
			raw,
			"todo",
			"reminders",
			"max",
			"remindersMax",
			value => typeof value === "number" && Number.isFinite(value),
		);

		// BM25 tool discovery removal: tools.discoveryMode / tools.essentialOverride /
		// mcp.discoveryMode / mcp.discoveryDefaultServers are gone with no
		// replacement (`tools.xdev` stays at its own default). Dead keys are
		// deleted so they stop lingering in config.yml.
		const toolsObj = raw.tools as Record<string, unknown> | undefined;
		if (toolsObj) {
			delete toolsObj.discoveryMode;
			delete toolsObj.essentialOverride;
		}
		delete raw["tools.discoveryMode"];
		delete raw["tools.essentialOverride"];
		const mcpObj = raw.mcp as Record<string, unknown> | undefined;
		if (mcpObj) {
			delete mcpObj.discoveryMode;
			delete mcpObj.discoveryDefaultServers;
		}
		delete raw["mcp.discoveryMode"];
		delete raw["mcp.discoveryDefaultServers"];

		// providers.webSearch / providers.image (single preferred provider) →
		// providers.webSearchOrder / providers.imageOrder (priority lists). A
		// concrete legacy choice becomes the head of the new list with every
		// remaining provider appended in its built-in order, so the old
		// preference stays #1 and the fallback chain is written out explicitly.
		// "auto" (or an unknown id) just drops the key — the default chain.
		const providerPrefsObj = raw.providers as Record<string, unknown> | undefined;
		const migrateProviderPreference = (
			legacyKey: string,
			orderKey: string,
			expand: (value: string) => string[] | undefined,
		): void => {
			const flatLegacyKey = `providers.${legacyKey}`;
			const legacy = providerPrefsObj?.[legacyKey] ?? raw[flatLegacyKey];
			if (legacy === undefined) return;
			const existingOrder = providerPrefsObj?.[orderKey] ?? raw[`providers.${orderKey}`];
			const orderAlreadySet = Array.isArray(existingOrder) && existingOrder.length > 0;
			if (!orderAlreadySet && typeof legacy === "string") {
				const expanded = expand(legacy);
				if (expanded) {
					const root = providerPrefsObj ?? {};
					root[orderKey] = expanded;
					raw.providers = root;
				}
			}
			if (providerPrefsObj) delete providerPrefsObj[legacyKey];
			delete raw[flatLegacyKey];
		};
		migrateProviderPreference("webSearch", "webSearchOrder", value =>
			value !== "auto" && isSearchProviderId(value)
				? [value, ...SEARCH_PROVIDER_ORDER.filter(id => id !== value)]
				: undefined,
		);
		migrateProviderPreference("image", "imageOrder", value =>
			value !== "auto" && isImageProviderId(value)
				? [value, ...AUTO_IMAGE_PROVIDER_ORDER.filter(id => id !== value)]
				: undefined,
		);

		// Consolidate the retired Exa suite toggles onto the sole remaining
		// provider switch. The old runtime required both `enabled` and
		// `enableSearch`, so preserve that AND semantics when both are present.
		// Researcher and Websets were removed with the standalone Exa tools.
		const exaObj = isRecord(raw.exa) ? raw.exa : undefined;
		const exaEnabledValues = [
			exaObj?.enabled,
			raw["exa.enabled"],
			exaObj?.enableSearch,
			raw["exa.enableSearch"],
		].filter((value): value is boolean => typeof value === "boolean");
		const hasFlatExaSetting =
			"exa.enabled" in raw ||
			"exa.enableSearch" in raw ||
			"exa.enableResearcher" in raw ||
			"exa.enableWebsets" in raw;
		if (exaObj || hasFlatExaSetting) {
			const exaRoot = exaObj ?? {};
			if (exaEnabledValues.length > 0) {
				exaRoot.enabled = exaEnabledValues.every(Boolean);
			}
			delete exaRoot.enableSearch;
			delete exaRoot.enableResearcher;
			delete exaRoot.enableWebsets;
			if (Object.keys(exaRoot).length > 0) {
				raw.exa = exaRoot;
			} else {
				delete raw.exa;
			}
			delete raw["exa.enabled"];
			delete raw["exa.enableSearch"];
			delete raw["exa.enableResearcher"];
			delete raw["exa.enableWebsets"];
		}

		// computer.backend and model-specific controller routing were removed
		// when the computer tool moved to one native desktop implementation.
		const computerObj = isRecord(raw.computer) ? raw.computer : undefined;
		if (computerObj && "backend" in computerObj) {
			delete computerObj.backend;
			if (Object.keys(computerObj).length === 0) {
				delete raw.computer;
			}
		}
		delete raw["computer.backend"];

		return raw;
	}

	/**
	 * One-time migration: seed the last-changelog-version marker file from the
	 * legacy config.yml key. An existing marker always wins — it is the newer
	 * source of truth.
	 */
	async #seedLastChangelogVersionMarker(): Promise<void> {
		const legacy = this.#legacyLastChangelogVersion;
		if (!legacy) return;
		const markerPath = getLastChangelogVersionPath(this.#agentDir);
		try {
			if ((await Bun.file(markerPath).text()).trim()) return;
		} catch (error) {
			if (!isEnoent(error)) return;
		}
		try {
			await Bun.write(markerPath, legacy);
		} catch (error) {
			logger.warn("Settings: failed to seed last-changelog-version marker", { error: String(error) });
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Saving
	// ─────────────────────────────────────────────────────────────────────────

	async #writeYamlAtomically(filePath: string, settings: RawSettings): Promise<void> {
		const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
		let removeTemp = false;
		try {
			const handle = await fs.promises.open(tempPath, "wx", 0o600);
			removeTemp = true;
			try {
				await handle.writeFile(YAML.stringify(settings, null, 2), "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			try {
				await fs.promises.rename(tempPath, filePath);
			} catch (error) {
				if (!hasFsCode(error, "EPERM")) throw error;
				await this.#replaceYamlAfterEperm(tempPath, filePath, error);
			}
			removeTemp = false;
		} finally {
			if (removeTemp) {
				await fs.promises.rm(tempPath, { force: true }).catch(() => {});
			}
		}
	}
	async #replaceYamlAfterEperm(tempPath: string, filePath: string, renameError: unknown): Promise<void> {
		const backupPath = `${filePath}.${process.pid}.${randomUUID()}.bak`;
		try {
			await fs.promises.rename(filePath, backupPath);
		} catch (error) {
			if (isEnoent(error)) {
				await fs.promises.rename(tempPath, filePath);
				return;
			}
			throw renameError;
		}

		try {
			await fs.promises.rename(tempPath, filePath);
		} catch (replaceError) {
			try {
				await fs.promises.rename(backupPath, filePath);
			} catch (rollbackError) {
				throw new Error(
					`Failed to replace settings file after EPERM (original: ${toError(renameError).message}; retry: ${
						toError(replaceError).message
					}; rollback: ${toError(rollbackError).message})`,
					{ cause: toError(renameError) },
				);
			}
			throw replaceError;
		}

		try {
			await fs.promises.rm(backupPath);
		} catch (error) {
			if (!isEnoent(error)) {
				logger.warn("Settings: failed to remove atomic-write backup", {
					path: filePath,
					backupPath,
					error: toError(error).message,
				});
			}
		}
	}

	#captureEffectiveSettings(): Map<SettingPath, unknown> {
		const values = new Map<SettingPath, unknown>();
		for (const settingPath of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
			values.set(settingPath, structuredClone(this.get(settingPath)));
		}
		return values;
	}

	#notifySynchronizedSettings(previous: Map<SettingPath, unknown>, emitSynchronizationSignal = true): void {
		const changedPaths: SettingPath[] = [];
		for (const settingPath of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
			const before = previous.get(settingPath);
			const after = this.get(settingPath);
			if (isDeepStrictEqual(after, before)) continue;
			const hook = SETTING_HOOKS[settingPath];
			if (hook) hook(after as never, before as never);
			this.#fireEffectiveSettingChanged(settingPath, after, before);
			changedPaths.push(settingPath);
		}
		if (emitSynchronizationSignal && changedPaths.length > 0) settingsSynchronizedSignal.fire(this, changedPaths);
	}

	#hasValidActiveProfile(target: RawSettings): boolean {
		const active = getByPath(target, ["profiles", "active"]);
		const items = getByPath(target, ["profiles", "items"]);
		return (
			typeof active === "string" &&
			active.length > 0 &&
			isRecord(items) &&
			this.#profileSnapshotFromUnknown(items[active]) !== undefined
		);
	}

	#profileSnapshotFromUnknown(
		raw: unknown,
	): { modelRoles: Record<string, string>; defaultThinkingLevel: string } | undefined {
		if (!isRecord(raw) || typeof raw.defaultThinkingLevel !== "string" || !isRecord(raw.modelRoles)) {
			return undefined;
		}
		const modelRoles: Record<string, string> = {};
		for (const [role, value] of Object.entries(raw.modelRoles)) {
			if (typeof value !== "string") return undefined;
			modelRoles[role] = value;
		}
		return { modelRoles, defaultThinkingLevel: raw.defaultThinkingLevel };
	}

	#reconcileDeletedActiveProfile(target: RawSettings): void {
		const active = getByPath(target, ["profiles", "active"]);
		if (typeof active !== "string" || active.length === 0) return;
		const items = getByPath(target, ["profiles", "items"]);
		if (isRecord(items) && this.#profileSnapshotFromUnknown(items[active])) return;

		const fallback = isRecord(items)
			? Object.entries(items)
					.map(([name, raw]) => ({ name, snapshot: this.#profileSnapshotFromUnknown(raw) }))
					.filter(
						(
							entry,
						): entry is {
							name: string;
							snapshot: { modelRoles: Record<string, string>; defaultThinkingLevel: string };
						} => entry.snapshot !== undefined,
					)
					.sort((a, b) => a.name.localeCompare(b.name))[0]
			: undefined;
		if (!fallback) {
			setByPath(target, ["profiles", "active"], "");
			return;
		}
		setByPath(target, ["profiles", "active"], fallback.name);
		setByPath(target, ["modelRoles"], { ...fallback.snapshot.modelRoles });
		setByPath(target, ["defaultThinkingLevel"], fallback.snapshot.defaultThinkingLevel);
	}

	/** Reload global settings after another process atomically replaces config.yml. */
	async syncFromDisk(): Promise<boolean> {
		if (!this.#persist || !this.#configPath || this.#savesCancelled) return false;
		const lifecycleEpoch = this.#lifecycleEpoch;
		await this.flush();
		if (this.#savesCancelled || lifecycleEpoch !== this.#lifecycleEpoch) return false;
		const mutationGeneration = this.#persistedMutationGeneration;
		const result = await this.#loadYamlIfPresent(this.#configPath);
		if (
			this.#savesCancelled ||
			lifecycleEpoch !== this.#lifecycleEpoch ||
			mutationGeneration !== this.#persistedMutationGeneration
		)
			return false;
		if (result.kind !== "loaded") {
			if (result.kind !== "missing") {
				logger.warn("Settings: ignored invalid external config update", {
					path: this.#configPath,
					error: String(result.error),
				});
			}
			return false;
		}
		const previous = this.#captureEffectiveSettings();
		const previousGlobal = this.#global;
		const localActive = this.#profileRuntimeOwner;
		const localLiveRoles = this.#modelRolesFromLayer(previousGlobal);
		const previousThinking = getByPath(previousGlobal, ["defaultThinkingLevel"]);
		const previousItems = getByPath(previousGlobal, ["profiles", "items"]);
		const previousLocalSnapshot =
			typeof localActive === "string" && isRecord(previousItems)
				? this.#profileSnapshotFromUnknown(previousItems[localActive])
				: undefined;
		this.#global = result.settings;

		const items = getByPath(this.#global, ["profiles", "items"]);
		const incomingLocalSnapshot =
			typeof localActive === "string" && localActive.length > 0 && isRecord(items)
				? this.#profileSnapshotFromUnknown(items[localActive])
				: undefined;

		if (incomingLocalSnapshot && localActive) {
			setByPath(this.#global, ["profiles", "active"], localActive);
			if (!previousLocalSnapshot || !isDeepStrictEqual(previousLocalSnapshot, incomingLocalSnapshot)) {
				// Same-profile edits are shared state: every terminal using this profile
				// adopts its new model/thinking snapshot even when another profile is
				// the startup default on disk.
				setByPath(this.#global, ["modelRoles"], { ...incomingLocalSnapshot.modelRoles });
				setByPath(this.#global, ["defaultThinkingLevel"], incomingLocalSnapshot.defaultThinkingLevel);
			} else {
				// A different terminal's activation changes root live fields but not this
				// profile snapshot. Preserve this terminal's local profile state.
				setByPath(this.#global, ["modelRoles"], localLiveRoles);
				if (typeof previousThinking === "string") {
					setByPath(this.#global, ["defaultThinkingLevel"], previousThinking);
				}
			}
			this.#reconcileProfileRuntimeOverrides(this.#global, previousGlobal);
		} else if (localActive) {
			// Locally active profile was deleted by another instance: reconcile to
			// the first valid remaining fallback profile and sync the change.
			setByPath(this.#global, ["profiles", "active"], localActive);
			this.#reconcileDeletedActiveProfile(this.#global);
			this.#reconcileProfileRuntimeOverrides(this.#global, previousGlobal);
		} else {
			// Empty is a terminal-local selection too. Another terminal's first
			// profile/activation only changes the startup default on disk.
			setByPath(this.#global, ["profiles", "active"], "");
			setByPath(this.#global, ["modelRoles"], localLiveRoles);
			if (typeof previousThinking === "string") {
				setByPath(this.#global, ["defaultThinkingLevel"], previousThinking);
			}
			this.#reconcileProfileRuntimeOverrides(this.#global, previousGlobal);
		}

		this.#rebuildMerged();
		this.#notifySynchronizedSettings(previous);
		return true;
	}

	#readGlobalWatchFingerprint(): string | undefined {
		if (!this.#configPath) return "missing";
		try {
			const stat = fs.statSync(this.#configPath, { throwIfNoEntry: false });
			return stat ? `${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}:${stat.size}` : "missing";
		} catch (error) {
			logger.warn("Settings: failed to poll global config", { path: this.#configPath, error: String(error) });
			return undefined;
		}
	}

	#startGlobalSettingsWatch(): void {
		if (!this.#persist || !this.#configPath || this.#globalWatchTimer) return;
		this.#globalWatchFingerprint = this.#readGlobalWatchFingerprint();
		this.#globalWatchTimer = setInterval(() => {
			const nextFingerprint = this.#readGlobalWatchFingerprint();
			if (
				nextFingerprint === undefined ||
				nextFingerprint === this.#globalWatchFingerprint ||
				this.#externalReloadPromise
			)
				return;
			const reload = this.syncFromDisk()
				.then(synchronized => {
					if (synchronized) this.#globalWatchFingerprint = nextFingerprint;
				})
				.catch(error => logger.warn("Settings: external config synchronization failed", { error: String(error) }));
			this.#externalReloadPromise = reload;
			void reload.finally(() => {
				if (this.#externalReloadPromise === reload) this.#externalReloadPromise = undefined;
			});
		}, 250);
		this.#globalWatchTimer.unref();
	}

	#queueSave(): void {
		if (!this.#persist || !this.#configPath) return;

		// Debounce: wait 100ms for more changes
		clearTimeout(this.#saveTimer);
		this.#saveTimer = setTimeout(() => {
			this.#saveTimer = undefined;
			const previousSave = this.#savePromise;
			const savePromise = (previousSave ?? Promise.resolve()).catch(() => undefined).then(() => this.#saveNow());
			this.#savePromise = savePromise;
			savePromise
				.catch(err => {
					logger.warn("Settings: background save failed", { error: String(err) });
				})
				.finally(() => {
					if (this.#savePromise === savePromise) {
						this.#savePromise = undefined;
					}
				});
		}, 100);
	}

	async #saveNow(): Promise<void> {
		if (this.#savesCancelled || !this.#persist || !this.#configPath) return;
		if (
			this.#modified.size === 0 &&
			this.#modifiedProfileItems.size === 0 &&
			this.#modifiedProfileLiveFields.size === 0 &&
			this.#modifiedProfileRenames.size === 0 &&
			this.#modifiedGlobalModelRoles.size === 0 &&
			this.#modifiedProfileActivation === undefined
		)
			return;

		const effectiveBeforeSave = this.#captureEffectiveSettings();
		const previousGlobal = structuredClone(this.#global);
		const configPath = this.#configPath;
		const modifiedPaths = [...this.#modified];
		const modifiedModelRoles = [...this.#modifiedGlobalModelRoles];
		const globalRolesAtStart = this.#modelRolesFromLayer(this.#global);
		this.#modified.clear();
		const modifiedProfileItems = new Map(this.#modifiedProfileItems);
		this.#modifiedProfileItems.clear();
		const modifiedProfileLiveFields = new Map(
			[...this.#modifiedProfileLiveFields].map(([profile, delta]) => [
				profile,
				{ defaultThinkingLevel: delta.defaultThinkingLevel, modelRoles: new Map(delta.modelRoles) },
			]),
		);
		this.#modifiedProfileLiveFields.clear();
		const modifiedProfileRenames = new Map(this.#modifiedProfileRenames);
		this.#modifiedProfileRenames.clear();
		this.#modifiedGlobalModelRoles.clear();
		const modifiedProfileActivation = this.#modifiedProfileActivation;
		this.#modifiedProfileActivation = undefined;
		let localProfileActivationApplied = false;

		let localActive: unknown;
		let localLiveRoles: Record<string, string> = {};
		let localThinking: unknown;
		try {
			await this.#withYamlWriteLock(configPath, async writePath => {
				// Re-read to preserve external changes. If this instance moved a
				// malformed file aside, recover from its last in-memory state
				// rather than recreating the config from only the pending path.
				const loaded = await this.#loadYamlIfPresentForWriteLocked(configPath, writePath);
				const current =
					loaded ?? (this.#quarantinedYamlTargets.has(configPath) ? structuredClone(this.#global) : {});
				const rawActiveAtRead = getByPath(current, ["profiles", "active"]);
				const activeAtRead = typeof rawActiveAtRead === "string" ? rawActiveAtRead : "";

				// Apply only our modified whole-value paths
				for (const modPath of modifiedPaths) {
					const segments = modPath.split(".");
					const value = getByPath(this.#global, segments);
					setByPath(current, segments, value);
				}

				// Merge touched profile keys before renames. A profile created or
				// updated and renamed within one debounce window must first exist at
				// its durable source key; the rename then moves that fresh value.
				for (const [profileName, op] of modifiedProfileItems) {
					if (op === "delete") {
						const items = getByPath(current, ["profiles", "items"]);
						if (isRecord(items)) delete items[profileName];
						continue;
					}
					if (op === "update") {
						const items = getByPath(current, ["profiles", "items"]);
						if (!isRecord(items) || !Object.hasOwn(items, profileName)) continue;
					}
					let localProfileName = profileName;
					for (;;) {
						const rename = modifiedProfileRenames.get(localProfileName);
						if (!rename) break;
						localProfileName = rename.newName;
					}
					setByPath(
						current,
						["profiles", "items", profileName],
						structuredClone(getByPath(this.#global, ["profiles", "items", localProfileName])),
					);
				}

				for (const [profileName, delta] of modifiedProfileLiveFields) {
					const items = getByPath(current, ["profiles", "items"]);
					const snapshot = isRecord(items) ? this.#profileSnapshotFromUnknown(items[profileName]) : undefined;
					if (!snapshot) continue;
					const modelRoles = { ...snapshot.modelRoles };
					for (const [role, modelId] of delta.modelRoles) {
						if (modelId === undefined) delete modelRoles[role];
						else modelRoles[role] = modelId;
					}
					setByPath(current, ["profiles", "items", profileName], {
						modelRoles,
						defaultThinkingLevel: delta.defaultThinkingLevel ?? snapshot.defaultThinkingLevel,
					});
				}

				const successfulProfileRenames = new Map<string, string>();
				const failedActiveProfileRenames = new Map<string, string>();
				for (const [oldName, rename] of modifiedProfileRenames) {
					const items = getByPath(current, ["profiles", "items"]);
					const canRename =
						isRecord(items) && Object.hasOwn(items, oldName) && !Object.hasOwn(items, rename.newName);
					if (canRename) {
						successfulProfileRenames.set(oldName, rename.newName);
						items[rename.newName] = structuredClone(items[oldName]);
						delete items[oldName];
						if (activeAtRead === oldName) setByPath(current, ["profiles", "active"], rename.newName);
					} else if (rename.wasActive) {
						failedActiveProfileRenames.set(oldName, rename.newName);
						if (modifiedProfileActivation?.targetName === rename.newName) {
							modifiedProfileActivation.targetName = oldName;
						}
					}
				}

				// Merge only the model roles captured by this save. Then retain
				// any role changed while the async read/lock was pending before
				// replacing #global, so the follow-up save still sees its value.
				const latestGlobalRoles = this.#modelRolesFromLayer(this.#global);
				const rolesToPreserve = new Set(this.#modifiedGlobalModelRoles);
				for (const role in globalRolesAtStart) {
					if (globalRolesAtStart[role] !== latestGlobalRoles[role]) {
						rolesToPreserve.add(role);
					}
				}
				for (const role in latestGlobalRoles) {
					if (globalRolesAtStart[role] !== latestGlobalRoles[role]) {
						rolesToPreserve.add(role);
					}
				}
				if (modifiedModelRoles.length > 0 || rolesToPreserve.size > 0) {
					const currentRoles = getByPath(current, ["modelRoles"]);
					const mergedRoles: Record<string, unknown> = isRecord(currentRoles) ? { ...currentRoles } : {};
					for (const role of modifiedModelRoles) {
						if (Object.hasOwn(globalRolesAtStart, role)) {
							mergedRoles[role] = globalRolesAtStart[role];
						} else {
							delete mergedRoles[role];
						}
					}
					for (const role of rolesToPreserve) {
						if (Object.hasOwn(latestGlobalRoles, role)) {
							mergedRoles[role] = latestGlobalRoles[role];
						} else {
							delete mergedRoles[role];
						}
					}
					setByPath(current, ["modelRoles"], mergedRoles);
				}
				if (modifiedProfileActivation) {
					const items = getByPath(current, ["profiles", "items"]);
					const targetSnapshot = isRecord(items)
						? this.#profileSnapshotFromUnknown(items[modifiedProfileActivation.targetName])
						: undefined;
					if (targetSnapshot) {
						setByPath(current, ["profiles", "active"], modifiedProfileActivation.targetName);
						setByPath(current, ["modelRoles"], { ...targetSnapshot.modelRoles });
						setByPath(current, ["defaultThinkingLevel"], targetSnapshot.defaultThinkingLevel);
						localProfileActivationApplied = true;
					}
				}

				// A profile deleted by another instance may still be selected in this
				// writer's stale memory. Resolve the durable marker and live settings
				// together so every watcher observes one deterministic fallback.
				this.#reconcileDeletedActiveProfile(current);
				const durableActive = getByPath(current, ["profiles", "active"]);
				const durableItems = getByPath(current, ["profiles", "items"]);
				const durableSnapshot =
					typeof durableActive === "string" && isRecord(durableItems)
						? this.#profileSnapshotFromUnknown(durableItems[durableActive])
						: undefined;
				if (durableSnapshot) {
					// Root live fields are the startup profile projection. A terminal
					// editing a different local profile updates only that profile item.
					setByPath(current, ["modelRoles"], { ...durableSnapshot.modelRoles });
					setByPath(current, ["defaultThinkingLevel"], durableSnapshot.defaultThinkingLevel);
				}

				// Keep this terminal's live state separate while the durable merged
				// snapshot is written. Local mutations may arrive during the await.
				await this.#writeYamlAtomically(writePath, current);
				this.#globalWatchFingerprint = this.#readGlobalWatchFingerprint();
				this.#quarantinedYamlTargets.delete(configPath);
				const latestLocalGlobal = this.#global;
				for (const [oldName, newName] of failedActiveProfileRenames) {
					if (this.#modifiedProfileActivation !== undefined || this.#profileRuntimeOwner !== newName) continue;
					const currentItems = getByPath(current, ["profiles", "items"]);
					const sourceSnapshot = isRecord(currentItems)
						? this.#profileSnapshotFromUnknown(currentItems[oldName])
						: undefined;
					if (!sourceSnapshot) continue;
					this.#profileRuntimeOwner = oldName;
					for (const owned of this.#profileOwnedModelRoleOverrides.values()) owned.profile = oldName;
					if (this.#profileOwnedThinkingOverride) this.#profileOwnedThinkingOverride.profile = oldName;

					const restoredSnapshot = structuredClone(sourceSnapshot);
					const pendingNewDelta = this.#modifiedProfileLiveFields.get(newName);
					if (pendingNewDelta) {
						let pendingOldDelta = this.#modifiedProfileLiveFields.get(oldName);
						if (!pendingOldDelta) {
							pendingOldDelta = { modelRoles: new Map() };
							this.#modifiedProfileLiveFields.set(oldName, pendingOldDelta);
						}
						if (pendingNewDelta.defaultThinkingLevel !== undefined) {
							pendingOldDelta.defaultThinkingLevel = pendingNewDelta.defaultThinkingLevel;
							restoredSnapshot.defaultThinkingLevel = pendingNewDelta.defaultThinkingLevel;
						}
						for (const [role, modelId] of pendingNewDelta.modelRoles) {
							pendingOldDelta.modelRoles.set(role, modelId);
							if (modelId === undefined) delete restoredSnapshot.modelRoles[role];
							else restoredSnapshot.modelRoles[role] = modelId;
						}
						this.#modifiedProfileLiveFields.delete(newName);
					}

					setByPath(latestLocalGlobal, ["profiles", "active"], oldName);
					setByPath(latestLocalGlobal, ["profiles", "items", oldName], restoredSnapshot);
					if (isRecord(currentItems) && Object.hasOwn(currentItems, newName)) {
						setByPath(latestLocalGlobal, ["profiles", "items", newName], structuredClone(currentItems[newName]));
					}
					setByPath(latestLocalGlobal, ["modelRoles"], { ...restoredSnapshot.modelRoles });
					setByPath(latestLocalGlobal, ["defaultThinkingLevel"], restoredSnapshot.defaultThinkingLevel);
				}
				for (const [oldName, newName] of successfulProfileRenames) {
					const pendingOld = this.#modifiedProfileLiveFields.get(oldName);
					if (!pendingOld) continue;
					let pendingNew = this.#modifiedProfileLiveFields.get(newName);
					if (!pendingNew) {
						pendingNew = { modelRoles: new Map() };
						this.#modifiedProfileLiveFields.set(newName, pendingNew);
					}
					if (pendingNew.defaultThinkingLevel === undefined) {
						pendingNew.defaultThinkingLevel = pendingOld.defaultThinkingLevel;
					}
					for (const [role, modelId] of pendingOld.modelRoles) {
						if (!pendingNew.modelRoles.has(role)) pendingNew.modelRoles.set(role, modelId);
					}
					this.#modifiedProfileLiveFields.delete(oldName);
				}
				const activationTarget = modifiedProfileActivation?.targetName;
				const hasNewerActivationState =
					this.#modifiedProfileActivation !== undefined ||
					(activationTarget !== undefined &&
						(this.#modifiedProfileItems.has(activationTarget) ||
							this.#modifiedProfileLiveFields.has(activationTarget))) ||
					this.#modified.has("modelRoles") ||
					this.#modified.has("defaultThinkingLevel") ||
					this.#modifiedGlobalModelRoles.size > 0;
				const localStateSource =
					localProfileActivationApplied && !hasNewerActivationState ? current : latestLocalGlobal;
				localActive = getByPath(localStateSource, ["profiles", "active"]);
				localLiveRoles = this.#modelRolesFromLayer(localStateSource);
				localThinking = getByPath(localStateSource, ["defaultThinkingLevel"]);
				for (const modPath of this.#modified) {
					const segments = modPath.split(".");
					setByPath(current, segments, structuredClone(getByPath(latestLocalGlobal, segments)));
				}
				const pendingProfileNames = new Set(this.#modifiedProfileItems.keys());
				for (const profileName of this.#modifiedProfileLiveFields.keys()) pendingProfileNames.add(profileName);
				for (const [oldName, rename] of this.#modifiedProfileRenames) {
					pendingProfileNames.add(oldName);
					pendingProfileNames.add(rename.newName);
				}
				const latestProfileItems = getByPath(latestLocalGlobal, ["profiles", "items"]);
				for (const profileName of pendingProfileNames) {
					const currentItems = getByPath(current, ["profiles", "items"]);
					if (isRecord(latestProfileItems) && Object.hasOwn(latestProfileItems, profileName)) {
						setByPath(
							current,
							["profiles", "items", profileName],
							structuredClone(latestProfileItems[profileName]),
						);
					} else if (isRecord(currentItems)) {
						delete currentItems[profileName];
					}
				}
				if (this.#modifiedGlobalModelRoles.size > 0) {
					const currentRoles = this.#modelRolesFromLayer(current);
					const latestRoles = this.#modelRolesFromLayer(latestLocalGlobal);
					for (const role of this.#modifiedGlobalModelRoles) {
						if (Object.hasOwn(latestRoles, role)) currentRoles[role] = latestRoles[role];
						else delete currentRoles[role];
					}
					setByPath(current, ["modelRoles"], currentRoles);
				}
				this.#global = current;
				// These pending roles were included in this write. Remove each
				// only if no newer local change arrived while the write was in flight.
				const globalRolesAfterWrite = this.#modelRolesFromLayer(current);
				for (const role of rolesToPreserve) {
					if (latestGlobalRoles[role] === globalRolesAfterWrite[role]) {
						this.#modifiedGlobalModelRoles.delete(role);
					}
				}
			});
		} catch (error) {
			logger.warn("Settings: save failed", { error: String(error) });
			// Re-add failed paths for retry
			for (const p of modifiedPaths) {
				this.#modified.add(p);
			}
			for (const [profileName, op] of modifiedProfileItems) {
				if (!this.#modifiedProfileItems.has(profileName)) {
					this.#modifiedProfileItems.set(profileName, op);
				}
			}
			for (const [profileName, failedDelta] of modifiedProfileLiveFields) {
				let pending = this.#modifiedProfileLiveFields.get(profileName);
				if (!pending) {
					pending = { modelRoles: new Map() };
					this.#modifiedProfileLiveFields.set(profileName, pending);
				}
				if (pending.defaultThinkingLevel === undefined) {
					pending.defaultThinkingLevel = failedDelta.defaultThinkingLevel;
				}
				for (const [role, modelId] of failedDelta.modelRoles) {
					if (!pending.modelRoles.has(role)) pending.modelRoles.set(role, modelId);
				}
			}
			for (const [oldName, rename] of modifiedProfileRenames) {
				if (!this.#modifiedProfileRenames.has(oldName)) this.#modifiedProfileRenames.set(oldName, rename);
			}
			for (const role of modifiedModelRoles) {
				this.#modifiedGlobalModelRoles.add(role);
			}
			this.#rebuildMerged();
			if (!this.#modifiedProfileActivation && modifiedProfileActivation) {
				this.#modifiedProfileActivation = modifiedProfileActivation;
			}
			throw error;
		}

		const items = getByPath(this.#global, ["profiles", "items"]);
		const localProfileExists =
			typeof localActive === "string" &&
			localActive.length > 0 &&
			isRecord(items) &&
			this.#profileSnapshotFromUnknown(items[localActive]) !== undefined;
		if (localProfileExists) {
			// Preserve this terminal's active profile while retaining unrelated
			// values merged from disk. The durable active marker was already written.
			setByPath(this.#global, ["profiles", "active"], localActive);
			setByPath(this.#global, ["modelRoles"], localLiveRoles);
			if (typeof localThinking === "string") {
				setByPath(this.#global, ["defaultThinkingLevel"], localThinking);
			}
		} else if (typeof localActive === "string" && localActive.length > 0) {
			setByPath(this.#global, ["profiles", "active"], localActive);
			this.#reconcileDeletedActiveProfile(this.#global);
		}
		this.#reconcileProfileRuntimeOverrides(this.#global, previousGlobal);
		this.#rebuildMerged();
		this.#notifySynchronizedSettings(effectiveBeforeSave);
	}
	#queueProjectSave(): void {
		if (!this.#persist) return;

		clearTimeout(this.#projectSaveTimer);
		this.#projectSaveTimer = setTimeout(() => {
			this.#projectSaveTimer = undefined;
			const previousSave = this.#projectSavePromise;
			const savePromise = (previousSave ?? Promise.resolve())
				.catch(() => undefined)
				.then(() => this.#saveProjectNow());
			this.#projectSavePromise = savePromise;
			savePromise
				.catch(err => {
					logger.warn("Settings: background project save failed", { error: String(err) });
				})
				.finally(() => {
					if (this.#projectSavePromise === savePromise) {
						this.#projectSavePromise = undefined;
					}
				});
		}, 100);
	}

	async #saveProjectNow(): Promise<void> {
		if (this.#savesCancelled || !this.#persist || this.#modifiedProjectModelRoles.size === 0) return;

		const projectConfigPath = path.join(this.#cwd, ".omp", "config.yml");
		const modifiedModelRoles = [...this.#modifiedProjectModelRoles];
		this.#modifiedProjectModelRoles.clear();

		try {
			await fs.promises.mkdir(path.dirname(projectConfigPath), { recursive: true });
			await this.#withYamlWriteLock(projectConfigPath, async writePath => {
				const loaded = await this.#loadYamlIfPresentForWriteLocked(projectConfigPath, writePath);
				const projectSettings =
					loaded ??
					(this.#quarantinedYamlTargets.has(projectConfigPath) ? structuredClone(this.#projectFileSettings) : {});

				const projectRoles = getByPath(this.#project, ["modelRoles"]);
				for (const role of modifiedModelRoles) {
					const value = isRecord(projectRoles) ? projectRoles[role] : undefined;
					setByPath(projectSettings, ["modelRoles", role], value);
				}

				await this.#writeYamlAtomically(writePath, projectSettings);
				this.#projectFileSettings = structuredClone(projectSettings);
				this.#quarantinedYamlTargets.delete(projectConfigPath);
			});
			invalidateCapabilityFsCache(projectConfigPath);
		} catch (error) {
			for (const role of modifiedModelRoles) {
				this.#modifiedProjectModelRoles.add(role);
			}
			throw error;
		}

		this.#rebuildMerged();
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Utilities
	// ─────────────────────────────────────────────────────────────────────────

	#projectSettingsForMerge(): RawSettings {
		const projectRoles = getByPath(this.#project, ["modelRoles"]);
		if (!isRecord(projectRoles)) return this.#project;

		let filteredRoles: Record<string, unknown> | undefined;
		for (const role in projectRoles) {
			if (!Object.hasOwn(projectRoles, role) || modelRoleValueFromUnknown(projectRoles[role]) !== undefined)
				continue;
			filteredRoles ??= { ...projectRoles };
			delete filteredRoles[role];
		}
		return filteredRoles ? { ...this.#project, modelRoles: filteredRoles } : this.#project;
	}

	#rebuildMerged(): void {
		this.#merged = this.#deepMerge(this.#deepMerge({}, this.#global), this.#projectSettingsForMerge());
		this.#merged = this.#deepMerge(this.#merged, this.#configOverlay);
		this.#merged = this.#deepMerge(this.#merged, this.#overrides);
		this.#resolvedCache.clear();
		this.#editVariantCache = undefined;
	}

	#fireAllHooks(): void {
		for (const key of Object.keys(SETTING_HOOKS) as SettingPath[]) {
			const hook = SETTING_HOOKS[key];
			if (hook) {
				const value = this.get(key);
				hook(value, value);
			}
		}
	}

	#deepMerge(base: RawSettings, overrides: RawSettings): RawSettings {
		const result = { ...base };
		for (const key of Object.keys(overrides)) {
			const override = overrides[key];
			const baseVal = base[key];

			if (override === undefined) continue;

			if (
				typeof override === "object" &&
				override !== null &&
				!Array.isArray(override) &&
				typeof baseVal === "object" &&
				baseVal !== null &&
				!Array.isArray(baseVal)
			) {
				result[key] = this.#deepMerge(baseVal as RawSettings, override as RawSettings);
			} else {
				result[key] = override;
			}
		}
		return result;
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Setting Hooks
// ═══════════════════════════════════════════════════════════════════════════

type SettingHook<P extends SettingPath> = (value: SettingValue<P>, prev: SettingValue<P>) => void;

/**
 * Minimal change-notification primitive backing the exported `on*Changed`
 * subscriptions. Holds a listener set, hands out unsubscribe closures, and
 * isolates errors so a single throwing listener can't abort the rest or bubble
 * out of `Settings.set()`.
 *
 * @typeParam A - argument tuple forwarded to each listener on `fire`.
 */
class SettingSignal<A extends unknown[] = []> {
	#listeners = new Set<(...args: A) => void>();

	constructor(private readonly label: string) {}

	/** Subscribe `cb`; returns an unsubscribe function. */
	on(cb: (...args: A) => void): () => void {
		this.#listeners.add(cb);
		return () => {
			this.#listeners.delete(cb);
		};
	}

	/**
	 * Invoke every listener with `args`. Iterates a snapshot so a listener may
	 * (un)subscribe mid-fire without re-entrancy — the Hindsight backend
	 * re-registers the fresh state's listener on every rebuild — and wraps each
	 * call so a throwing listener is logged and skipped instead of aborting the
	 * rest.
	 */
	fire(...args: A): void {
		for (const cb of [...this.#listeners]) {
			try {
				cb(...args);
			} catch (err) {
				logger.warn(`Settings: ${this.label} hook failed`, { error: String(err) });
			}
		}
	}
}

const SETTING_HOOKS: Partial<Record<SettingPath, SettingHook<any>>> = {
	"theme.dark": value => {
		if (typeof value === "string") {
			setAutoThemeMapping("dark", value);
		}
	},
	"theme.light": value => {
		if (typeof value === "string") {
			setAutoThemeMapping("light", value);
		}
	},
	symbolPreset: value => {
		if (typeof value === "string" && (value === "unicode" || value === "nerd" || value === "ascii")) {
			setSymbolPreset(value).catch(err => {
				logger.warn("Settings: symbolPreset hook failed", { preset: value, error: String(err) });
			});
		}
	},
	colorBlindMode: value => {
		if (typeof value === "boolean") {
			setColorBlindMode(value).catch(err => {
				logger.warn("Settings: colorBlindMode hook failed", { enabled: value, error: String(err) });
			});
		}
	},
	"provider.appendOnlyContext": value => {
		if (typeof value === "string") {
			appendOnlyModeSignal.fire(value);
		}
	},
	"providers.maxInFlightRequests": value => {
		configureProviderMaxInFlightRequests(validateProviderMaxInFlightRequests(value));
	},
	"secrets.enabled": value => {
		configureCredentialRedaction(value === true);
	},
	"hindsight.bankId": () => hindsightScopeSignal.fire(),
	"hindsight.bankIdPrefix": () => hindsightScopeSignal.fire(),
	"hindsight.scoping": () => hindsightScopeSignal.fire(),
	extendedContext: () => extendedContextSignal.fire(),
	"worktree.base": value => {
		const dir = typeof value === "string" && value.trim() ? value : undefined;
		// Always call so an unset/empty value clears a previously-applied override.
		// setWorktreesDir expands `~`, rejects relative paths, and returns the
		// applied absolute path (or undefined when cleared/rejected).
		if (dir && !setWorktreesDir(dir)) {
			logger.warn("Settings: worktree.base must be an absolute or ~-relative path; ignoring", { value: dir });
		} else if (!dir) {
			setWorktreesDir(undefined);
		}
	},
};
/** Fires when `provider.appendOnlyContext` changes at runtime. */
const appendOnlyModeSignal = new SettingSignal<[value: string]>("provider.appendOnlyContext");

/**
 * Subscribe to append-only mode setting changes.
 * Returns an unsubscribe function. Multiple sessions (main + subagents)
 * can register independently without overwriting each other.
 */
export const onAppendOnlyModeChanged = (cb: (value: string) => void) => appendOnlyModeSignal.on(cb);

/** Fires when any model role changes at runtime. */
const modelRolesSignal = new SettingSignal("modelRoles");

/** Subscribe to model role changes. Returns an unsubscribe function. */
export const onModelRolesChanged: (cb: () => void) => () => void = modelRolesSignal.on.bind(modelRolesSignal);

/** Fires after this process adopts settings written by another process or merged during a locked save. */
const settingsSynchronizedSignal = new SettingSignal<[source: Settings, changedPaths: readonly SettingPath[]]>(
	"settings synchronization",
);

/** Subscribe to synchronized settings changes from a specific Settings instance. */
export const onSettingsSynchronized = (
	cb: (source: Settings, changedPaths: readonly SettingPath[]) => void,
): (() => void) => settingsSynchronizedSignal.on(cb);

/** Fires when `extendedContext` changes at runtime. */
const extendedContextSignal = new SettingSignal("extendedContext");

/**
 * Subscribe to extended-context setting changes. Sessions re-derive their
 * model's effective context window (the registry clamps premium long-context
 * models to the standard-pricing threshold while the setting is off).
 * Returns an unsubscribe function.
 */
export const onExtendedContextChanged = (cb: () => void) => extendedContextSignal.on(cb);

/** Fires when `statusLine.sessionAccent` changes at runtime. */
const statusLineSessionAccentSignal = new SettingSignal("statusLine.sessionAccent");

/**
 * Subscribe to session-accent setting changes.
 * Returns an unsubscribe function. Callers should re-read settings in the callback.
 */
export const onStatusLineSessionAccentChanged = (cb: () => void) => statusLineSessionAccentSignal.on(cb);

/** Fires when any `hindsight.bankId` / `bankIdPrefix` / `scoping` value changes. */
const hindsightScopeSignal = new SettingSignal("hindsight scope");

/**
 * Subscribe to changes in the Hindsight bank-scoping settings. Lets the
 * Hindsight backend rebuild the active `HindsightSessionState` when the
 * operator switches `hindsight.bankId`, `hindsight.bankIdPrefix`, or
 * `hindsight.scoping` mid-session so subsequent retain/recall calls land in
 * the new bank instead of the one selected at session start.
 *
 * Returns an unsubscribe function. The callback receives no arguments — the
 * caller is expected to re-read the relevant settings via `Settings.get`.
 */
export const onHindsightScopeChanged = (cb: () => void) => hindsightScopeSignal.on(cb);

// ═══════════════════════════════════════════════════════════════════════════
// Global Singleton
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Weak registry of every constructed instance so `resetSettingsForTest` can
 * disarm stray background saves on isolated instances too. WeakRefs never
 * retain instances; the set is cleared on every test reset.
 */
const liveSettingsInstances = new Set<WeakRef<Settings>>();

let globalInstance: Settings | null = null;
let globalInstancePromise: Promise<Settings> | null = null;
let boundSettingsInstance: Settings | null = null;
let boundSettingsMethods = new Map<PropertyKey, unknown>();

function clearBoundSettingsMethods(): void {
	boundSettingsInstance = null;
	boundSettingsMethods = new Map<PropertyKey, unknown>();
}

export function isSettingsInitialized(): boolean {
	return globalInstance !== null;
}

/**
 * Reset the global singleton for testing.
 * @internal
 */
export function resetSettingsForTest(): void {
	// Disarm every constructed instance's debounced saves — including isolated
	// (non-singleton) instances: an armed timer or chained in-flight save on a
	// dropped instance fires mid-way through the NEXT test and races its file
	// locks/spies (cross-file pollution).
	for (const ref of liveSettingsInstances) {
		ref.deref()?.cancelPendingSaves();
	}
	liveSettingsInstances.clear();
	globalInstance = null;
	globalInstancePromise = null;
	clearBoundSettingsMethods();
	configureProviderMaxInFlightRequests(undefined);
	configureCredentialRedaction(false);
}

/**
 * Async test teardown variant. Synchronous reset remains immediate and safe;
 * callers removing temp dirs can await this to drain already-open file work.
 * @internal
 */
export async function resetSettingsForTestAsync(): Promise<void> {
	const instances = [...liveSettingsInstances]
		.map(ref => ref.deref())
		.filter((instance): instance is Settings => instance !== undefined);
	resetSettingsForTest();
	await Promise.all(instances.map(instance => instance.dispose()));
}

/**
 * The global settings singleton.
 * Must call `Settings.init()` before using.
 */
export const settings = new Proxy({} as Settings, {
	get(_target, prop) {
		if (!globalInstance) {
			throw new Error("Settings not initialized. Call Settings.init() first.");
		}
		if (boundSettingsInstance !== globalInstance) {
			clearBoundSettingsMethods();
			boundSettingsInstance = globalInstance;
		}
		const value = (globalInstance as unknown as Record<PropertyKey, unknown>)[prop];
		if (typeof value === "function") {
			const cached = boundSettingsMethods.get(prop);
			if (cached) return cached;
			const bound = value.bind(globalInstance);
			boundSettingsMethods.set(prop, bound);
			return bound;
		}
		return value;
	},
});

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════
