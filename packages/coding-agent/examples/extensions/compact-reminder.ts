import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ReadonlySessionManager } from "@oh-my-pi/pi-coding-agent";

export type CompactReminderConfig = {
	enabled: boolean;
	instructions: string;
	midRemind: boolean;
	midRemindStepTokens: number;
};

type MidReminderState = {
	sessionId: string;
	lastCheckpointTokens: number;
};

export const CONFIG_ENTRY = "compact-reminder-config";
export const MID_REMINDER_STATE_ENTRY = "compact-reminder-mid-state";
export const DEFAULT_INSTRUCTIONS =
	"Post-compaction checkpoint: re-read the current task, verify active constraints, " +
	"and continue from the latest compacted context. Do not assume omitted history.";
export const DEFAULT_MID_REMIND_STEP_TOKENS = 275_000;
const MIN_MID_REMIND_STEP_TOKENS = 1_000;
const MAX_MID_REMIND_STEP_TOKENS = 1_000_000;
const SETTINGS_MARKER = "--- reminder instructions ---";

export const DEFAULT_COMPACT_REMINDER_CONFIG: CompactReminderConfig = {
	enabled: true,
	instructions: DEFAULT_INSTRUCTIONS,
	midRemind: false,
	midRemindStepTokens: DEFAULT_MID_REMIND_STEP_TOKENS,
};

function parseTokenAmount(value: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(value.trim());
	if (!match) return undefined;
	const suffix = match[2].toLowerCase();
	const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
	const tokens = Number(match[1]) * multiplier;
	return Number.isSafeInteger(tokens) ? tokens : undefined;
}

export function formatTokenAmount(tokens: number): string {
	if (tokens % 1_000_000 === 0) return `${tokens / 1_000_000}m`;
	if (tokens % 1_000 === 0) return `${tokens / 1_000}k`;
	return String(tokens);
}

export function formatSettingsDocument(config: CompactReminderConfig): string {
	return [
		"# Try-compact settings for this session",
		"# enabled: send the visible reminder after compaction",
		"# midremind: also send it at context checkpoints before compaction",
		"# midremindstep: first checkpoint and spacing; accepts tokens, k, or m",
		`enabled=${config.enabled ? "on" : "off"}`,
		`midremind=${config.midRemind ? "on" : "off"}`,
		`midremindstep=${formatTokenAmount(config.midRemindStepTokens)}`,
		"",
		SETTINGS_MARKER,
		config.instructions.trim(),
		"",
	].join("\n");
}

export function parseSettingsDocument(text: string): CompactReminderConfig {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const markerIndex = lines.findIndex(line => line.trim().toLowerCase() === SETTINGS_MARKER);
	if (markerIndex < 0) throw new Error(`Missing settings marker: ${SETTINGS_MARKER}`);
	const values = new Map<string, string>();
	for (const rawLine of lines.slice(0, markerIndex)) {
		const line = rawLine.trim();
		if (!line || (line.startsWith("#") && !/^#(?:enabled|midremind|midremindstep)=/i.test(line))) continue;
		const normalized = line.startsWith("#") ? line.slice(1) : line;
		const separator = normalized.indexOf("=");
		if (separator < 1) throw new Error(`Invalid settings line: ${rawLine}`);
		const key = normalized.slice(0, separator).trim().toLowerCase();
		const value = normalized.slice(separator + 1).trim();
		if (!["enabled", "midremind", "midremindstep"].includes(key)) throw new Error(`Unknown setting: ${key}`);
		if (values.has(key)) throw new Error(`Duplicate setting: ${key}`);
		values.set(key, value);
	}
	const parseSwitch = (key: "enabled" | "midremind") => {
		const value = values.get(key)?.toLowerCase();
		if (value !== "on" && value !== "off") throw new Error(`${key} must be on or off`);
		return value === "on";
	};
	const step = parseTokenAmount(values.get("midremindstep") ?? "");
	if (step === undefined || step < MIN_MID_REMIND_STEP_TOKENS || step > MAX_MID_REMIND_STEP_TOKENS) {
		throw new Error(
			`midremindstep must be ${formatTokenAmount(MIN_MID_REMIND_STEP_TOKENS)}-${formatTokenAmount(MAX_MID_REMIND_STEP_TOKENS)}`,
		);
	}
	const instructions = lines
		.slice(markerIndex + 1)
		.join("\n")
		.trim();
	if (!instructions) throw new Error("Reminder instructions cannot be empty");
	return {
		enabled: parseSwitch("enabled"),
		midRemind: parseSwitch("midremind"),
		midRemindStepTokens: step,
		instructions,
	};
}

export function resolveMidReminderCheckpoint(
	contextTokens: number,
	lastCheckpointTokens: number,
	stepTokens: number,
): number | undefined {
	if (!Number.isFinite(contextTokens) || contextTokens < stepTokens) return undefined;
	const next = lastCheckpointTokens > 0 ? lastCheckpointTokens + stepTokens : stepTokens;
	if (contextTokens < next) return undefined;
	const anchor = lastCheckpointTokens > 0 ? lastCheckpointTokens : 0;
	return anchor + Math.floor((contextTokens - anchor) / stepTokens) * stepTokens;
}

function parseStoredConfig(data: unknown): CompactReminderConfig | undefined {
	if (!data || typeof data !== "object") return undefined;
	const record = data as Record<string, unknown>;
	if (typeof record.instructions !== "string" || !record.instructions.trim()) return undefined;
	const step =
		typeof record.midRemindStepTokens === "number" &&
		Number.isSafeInteger(record.midRemindStepTokens) &&
		record.midRemindStepTokens >= MIN_MID_REMIND_STEP_TOKENS &&
		record.midRemindStepTokens <= MAX_MID_REMIND_STEP_TOKENS
			? record.midRemindStepTokens
			: DEFAULT_MID_REMIND_STEP_TOKENS;
	return {
		enabled: record.enabled === undefined ? true : record.enabled === true,
		instructions: record.instructions,
		midRemind: record.midRemind === true,
		midRemindStepTokens: step,
	};
}

function readConfig(sessionManager: Pick<ReadonlySessionManager, "getEntries">): CompactReminderConfig {
	const entry = [...sessionManager.getEntries()]
		.reverse()
		.find(item => item.type === "custom" && item.customType === CONFIG_ENTRY);
	const parsed = parseStoredConfig(entry?.type === "custom" ? entry.data : undefined);
	return parsed ?? { ...DEFAULT_COMPACT_REMINDER_CONFIG };
}

function readMidReminderState(
	sessionManager: Pick<ReadonlySessionManager, "getEntries" | "getSessionId">,
): MidReminderState {
	const sessionId = sessionManager.getSessionId();
	for (const entry of [...sessionManager.getEntries()].reverse()) {
		if (entry.type !== "custom" || entry.customType !== MID_REMINDER_STATE_ENTRY) continue;
		const data = entry.data;
		if (!data || typeof data !== "object") continue;
		const record = data as Record<string, unknown>;
		if (record.sessionId !== sessionId) continue;
		if (typeof record.lastCheckpointTokens !== "number" || !Number.isSafeInteger(record.lastCheckpointTokens))
			continue;
		return { sessionId, lastCheckpointTokens: Math.max(0, record.lastCheckpointTokens) };
	}
	return { sessionId, lastCheckpointTokens: 0 };
}

function persistConfig(pi: Pick<ExtensionAPI, "appendEntry">, config: CompactReminderConfig): void {
	pi.appendEntry(CONFIG_ENTRY, config);
}

function persistMidReminderState(pi: Pick<ExtensionAPI, "appendEntry">, state: MidReminderState): void {
	pi.appendEntry(MID_REMINDER_STATE_ENTRY, state);
}

type ReminderPreset = {
	label: string;
	description: string;
	config: CompactReminderConfig;
};

async function discoverProjectPresets(
	sessionDir: string,
	currentSessionFile: string | undefined,
): Promise<ReminderPreset[]> {
	const files = (await readdir(sessionDir, { withFileTypes: true }))
		.filter(entry => entry.isFile() && entry.name.endsWith(".jsonl"))
		.map(entry => path.join(sessionDir, entry.name))
		.filter(file => file !== currentSessionFile)
		.sort()
		.reverse();
	const presets: ReminderPreset[] = [];
	for (const file of files) {
		try {
			const records = (await readFile(file, "utf8"))
				.split(/\r?\n/)
				.filter(Boolean)
				.map(line => JSON.parse(line) as Record<string, unknown>);
			const configRecords = records.filter(record => record.type === "custom" && record.customType === CONFIG_ENTRY);
			const config = parseStoredConfig(configRecords.at(-1)?.data);
			if (!config) continue;
			const titleRecord = [...records]
				.reverse()
				.find(record => ["title", "title_change"].includes(String(record.type)));
			const header = records.find(record => record.type === "session");
			const title =
				(typeof titleRecord?.title === "string" && titleRecord.title) ||
				(typeof header?.title === "string" && header.title) ||
				"Untitled session";
			const timestamp =
				typeof header?.timestamp === "string" ? header.timestamp.slice(0, 16).replace("T", " ") : "unknown date";
			const preview = config.instructions.replace(/\s+/g, " ").trim();
			const index = presets.length + 1;
			presets.push({
				label: `${index}. ${title} | ${config.enabled ? "on" : "off"} | mid ${config.midRemind ? "on" : "off"} | ${timestamp}`,
				description: preview.length > 180 ? `${preview.slice(0, 177)}...` : preview,
				config,
			});
			if (presets.length >= 200) break;
		} catch {
			// Ignore malformed or concurrently-written sessions.
		}
	}
	return presets;
}

function splitEditorCommand(command: string): { command: string; args: string[] } {
	const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
	const unquote = (part: string): string =>
		part.length >= 2 && ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'")))
			? part.slice(1, -1)
			: part;
	return { command: unquote(parts[0] ?? command), args: parts.slice(1).map(unquote) };
}

function addEditorWaitFlag(editor: { command: string; args: string[] }): { command: string; args: string[] } {
	const executable = path
		.basename(editor.command)
		.toLowerCase()
		.replace(/\.(?:cmd|exe|bat)$/, "");
	const alreadyWaits = editor.args.includes("--wait") || editor.args.includes("-w");
	if (!alreadyWaits && ["code", "code-insiders", "codium"].includes(executable)) {
		return { ...editor, args: ["--wait", ...editor.args] };
	}
	if (!alreadyWaits && ["subl", "sublime_text"].includes(executable)) {
		return { ...editor, args: ["-w", ...editor.args] };
	}
	return editor;
}

async function runExternalEditor(pi: Pick<ExtensionAPI, "exec">, file: string): Promise<void> {
	const configured = process.env.VISUAL || process.env.EDITOR;
	const editor = addEditorWaitFlag(
		configured
			? splitEditorCommand(configured)
			: process.platform === "win32"
				? { command: "notepad.exe", args: [] }
				: { command: "vi", args: [] },
	);
	const result = await pi.exec(editor.command, [...editor.args, file]);
	const exitCode = result.code ?? (result as typeof result & { exitCode?: number }).exitCode;
	if (exitCode !== 0)
		throw new Error(result.stderr.trim() || `External editor exited with code ${exitCode ?? "unknown"}`);
}

async function editSettingsWithExternalEditor(
	pi: Pick<ExtensionAPI, "exec">,
	config: CompactReminderConfig,
): Promise<CompactReminderConfig> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "omp-try-compact-"));
	const file = path.join(dir, "settings.txt");
	await writeFile(file, formatSettingsDocument(config), "utf8");
	try {
		await runExternalEditor(pi, file);
		return parseSettingsDocument(await readFile(file, "utf8"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function browseProjectPresets(
	pi: Pick<ExtensionAPI, "exec">,
	presets: ReminderPreset[],
): Promise<ReminderPreset | undefined> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "omp-try-compact-presets-"));
	const file = path.join(dir, "project-presets.md");
	const body = [
		"# Try-compact presets for this project",
		"# Set SELECT to a preset number, save, and close.",
		"SELECT:",
		"",
		...presets.flatMap((preset, index) => [
			`## ${index + 1}. ${preset.label.replace(/^\d+\.\s*/, "")}`,
			`Status: ${preset.config.enabled ? "on" : "off"}; mid-remind: ${preset.config.midRemind ? "on" : "off"}; step: ${formatTokenAmount(preset.config.midRemindStepTokens)}`,
			"Instructions:",
			preset.config.instructions.trim(),
			"",
		]),
	].join("\n");
	await writeFile(file, body, "utf8");
	try {
		await runExternalEditor(pi, file);
		const edited = await readFile(file, "utf8");
		const firstPreset = edited.indexOf("\n## ");
		const selectorHeader = firstPreset >= 0 ? edited.slice(0, firstPreset) : edited;
		const match = selectorHeader.match(/^SELECT:\s*(\d+)\s*$/m);
		return match ? presets[Number.parseInt(match[1], 10) - 1] : undefined;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function statusText(config: CompactReminderConfig, state: MidReminderState): string {
	const next = state.lastCheckpointTokens + config.midRemindStepTokens;
	return [
		`Try-compact for session ${state.sessionId}:`,
		`enabled=${config.enabled ? "on" : "off"}`,
		`midremind=${config.midRemind ? "on" : "off"}`,
		`midremindstep=${formatTokenAmount(config.midRemindStepTokens)}`,
		`lastmidremind=${state.lastCheckpointTokens > 0 ? formatTokenAmount(state.lastCheckpointTokens) : "none"}`,
		`nextmidremind=${formatTokenAmount(next)}`,
		`instructions=${config.instructions.trim()}`,
	].join("\n");
}

function usageContextTokens(usage: AssistantMessage["usage"]): number {
	if (typeof usage.contextTokens === "number" && Number.isFinite(usage.contextTokens)) {
		return Math.max(0, usage.contextTokens);
	}
	return Math.max(0, usage.input + usage.output + usage.cacheRead + usage.cacheWrite);
}

function latestContextTokens(messages: readonly unknown[]): number | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as Partial<AssistantMessage> | undefined;
		if (message?.role !== "assistant" || !message.usage) continue;
		return usageContextTokens(message.usage);
	}
	return undefined;
}

export default function compactReminderExtension(pi: ExtensionAPI) {
	let config = { ...DEFAULT_COMPACT_REMINDER_CONFIG };
	let midState: MidReminderState = { sessionId: "", lastCheckpointTokens: 0 };
	const automaticCompactionInFlight = new Map<string, string>();
	const automaticCompactionHandledAtCommit = new Set<string>();
	const automaticEndHandledAwaitingCommit = new Set<string>();
	const suppressNextAgentEndAfterCompaction = new Set<string>();
	const pendingReminderTurnSessions = new Set<string>();

	const syncState = (ctx: { sessionManager: ReadonlySessionManager }) => {
		config = readConfig(ctx.sessionManager);
		midState = readMidReminderState(ctx.sessionManager);
	};
	const sendReminder = (sessionManager: ReadonlySessionManager) => {
		if (!config.enabled || !config.instructions.trim()) return;
		pi.sendMessage(
			{
				customType: "compact-reminder",
				content: `[Compact reminder sent]\n${config.instructions}`,
				display: true,
				attribution: "user",
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		pendingReminderTurnSessions.add(sessionManager.getSessionId());
	};
	const resetMidReminder = (sessionManager: ReadonlySessionManager) => {
		const reset = { sessionId: sessionManager.getSessionId(), lastCheckpointTokens: 0 };
		persistMidReminderState(pi, reset);
		midState = reset;
	};
	const handleCompaction = (sessionManager: ReadonlySessionManager, suppressOriginalAgentEnd: boolean) => {
		resetMidReminder(sessionManager);
		if (suppressOriginalAgentEnd) {
			suppressNextAgentEndAfterCompaction.add(sessionManager.getSessionId());
		}
		sendReminder(sessionManager);
	};

	pi.on("session_start", async (_event, ctx) => syncState(ctx));
	pi.on("session_switch", async (_event, ctx) => syncState(ctx));
	pi.on("session_branch", async (_event, ctx) => syncState(ctx));

	const command = {
		description: "Configure visible post-compaction and mid-context reminders",
		handler: async (args: string, ctx: Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1]) => {
			syncState(ctx);
			const rawArgs = args.trim();
			const splitAt = rawArgs.indexOf(" ");
			const action = (splitAt === -1 ? rawArgs : rawArgs.slice(0, splitAt)).toLowerCase();
			const inline = splitAt === -1 ? "" : rawArgs.slice(splitAt + 1).trim();
			if (!action || action === "status") {
				ctx.ui.notify(statusText(config, midState), "info");
				return;
			}
			if (action === "settings") {
				ctx.ui.notify("Opening try-compact session settings. Save and close to apply.", "info");
				try {
					const edited = await editSettingsWithExternalEditor(pi, config);
					persistConfig(pi, edited);
					config = edited;
					ctx.ui.notify(`Try-compact settings saved.\n${statusText(config, midState)}`, "info");
				} catch (error) {
					ctx.ui.notify(
						`Try-compact settings not saved: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
				return;
			}
			if (action === "load") {
				let presets: ReminderPreset[];
				try {
					presets = await discoverProjectPresets(
						ctx.sessionManager.getSessionDir(),
						ctx.sessionManager.getSessionFile(),
					);
				} catch (error) {
					ctx.ui.notify(
						`Could not scan project sessions: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
					return;
				}
				if (presets.length === 0) {
					ctx.ui.notify("No try-compact presets found in other sessions for this project.", "warning");
					return;
				}
				const requestedIndex = inline && /^\d+$/.test(inline) ? Number.parseInt(inline, 10) - 1 : undefined;
				const preset = inline
					? requestedIndex !== undefined && requestedIndex >= 0
						? presets[requestedIndex]
						: undefined
					: await browseProjectPresets(pi, presets);
				if (!preset) {
					ctx.ui.notify(
						inline ? `Preset ${inline} does not exist.` : "No try-compact preset selected.",
						"warning",
					);
					return;
				}
				const loaded = { ...preset.config };
				persistConfig(pi, loaded);
				config = loaded;
				ctx.ui.notify(`Loaded try-compact preset.\n${statusText(config, midState)}`, "info");
				return;
			}
			if (action === "on" || action === "off") {
				const toggled = { ...config, enabled: action === "on" };
				persistConfig(pi, toggled);
				config = toggled;
				ctx.ui.notify(`Try-compact ${config.enabled ? "enabled" : "disabled"} for this session.`, "info");
				return;
			}
			ctx.ui.notify("Usage: /try-compact status|settings|load [number]|on|off", "info");
		},
	};
	pi.registerCommand("try-compact", command);
	pi.registerCommand("compact-remind", command);

	pi.on("auto_compaction_start", async (event, ctx) => {
		automaticCompactionInFlight.set(ctx.sessionManager.getSessionId(), event.reason);
	});

	pi.on("session_compact", async (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (automaticEndHandledAwaitingCommit.delete(sessionId)) return;
		const automaticReason = automaticCompactionInFlight.get(sessionId);
		handleCompaction(ctx.sessionManager, automaticReason !== undefined && automaticReason !== "idle");
		if (automaticReason !== undefined) automaticCompactionHandledAtCommit.add(sessionId);
	});

	pi.on("auto_compaction_end", async (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const automaticReason = automaticCompactionInFlight.get(sessionId);
		automaticCompactionInFlight.delete(sessionId);
		if (automaticCompactionHandledAtCommit.delete(sessionId)) return;
		if (!event.result || event.aborted) return;
		handleCompaction(ctx.sessionManager, automaticReason !== undefined && automaticReason !== "idle");
		automaticEndHandledAwaitingCommit.add(sessionId);
	});

	pi.on("agent_end", async (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (suppressNextAgentEndAfterCompaction.delete(sessionId)) return;
		if (pendingReminderTurnSessions.has(sessionId)) {
			if (event.willContinue !== true) pendingReminderTurnSessions.delete(sessionId);
			return;
		}
		if (!config.enabled || !config.midRemind || event.willContinue === true) {
			return;
		}
		const contextTokens = latestContextTokens(event.messages);
		if (contextTokens === undefined) return;
		const checkpoint = resolveMidReminderCheckpoint(
			contextTokens,
			midState.lastCheckpointTokens,
			config.midRemindStepTokens,
		);
		if (checkpoint === undefined) return;
		const consumed = { sessionId: ctx.sessionManager.getSessionId(), lastCheckpointTokens: checkpoint };
		persistMidReminderState(pi, consumed);
		midState = consumed;
		sendReminder(ctx.sessionManager);
	});
}
