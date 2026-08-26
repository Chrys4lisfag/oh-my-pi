import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { TempDir } from "@oh-my-pi/pi-utils";
import compactReminderExtension, {
	CONFIG_ENTRY,
	DEFAULT_COMPACT_REMINDER_CONFIG,
	formatSettingsDocument,
	MID_REMINDER_STATE_ENTRY,
	parseSettingsDocument,
	resolveMidReminderCheckpoint,
} from "../../examples/extensions/compact-reminder";

type TestEntry = { type: string; customType?: string; data?: unknown; [key: string]: unknown };
type TestContext = {
	sessionManager: {
		getEntries: () => TestEntry[];
		getSessionId: () => string;
		getSessionDir: () => string;
		getSessionFile: () => string;
	};
	ui: { notify: (message: string, level: string) => void };
};
type Handler = (event: unknown, context: TestContext) => Promise<void> | void;

function createHarness(
	options: {
		sessionId?: string;
		entries?: TestEntry[];
		exec?: ExtensionAPI["exec"];
		appendEntry?: (customType: string, data: unknown) => void;
	} = {},
) {
	const entries = options.entries ?? [];
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, context: TestContext) => Promise<void> }>();
	const messages: Array<{ message: unknown; options: unknown }> = [];
	const operations: string[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	let sessionId = options.sessionId ?? "session-a";
	const sessionDir = TempDir.createSync("@pi-try-compact-sessions-");
	const sessionFile = path.join(sessionDir.path(), "current.jsonl");
	const sessionManager = {
		getEntries: () => entries,
		getSessionId: () => sessionId,
		getSessionDir: () => sessionDir.path(),
		getSessionFile: () => sessionFile,
	};
	const context = {
		sessionManager,
		ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
	};
	const pi = {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerCommand(name: string, command: { handler: (args: string, context: TestContext) => Promise<void> }) {
			commands.set(name, command);
		},
		appendEntry(customType: string, data: unknown) {
			options.appendEntry?.(customType, data);
			entries.push({ type: "custom", customType, data });
			operations.push(`append:${customType}`);
		},
		sendMessage(message: unknown, sendOptions: unknown) {
			messages.push({ message, options: sendOptions });
			operations.push("send");
		},
		exec:
			options.exec ?? ((async () => ({ stdout: "", stderr: "", code: 0, killed: false })) as ExtensionAPI["exec"]),
	} as unknown as ExtensionAPI;
	compactReminderExtension(pi);
	const emit = async (name: string, event: unknown = {}) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, context);
	};
	return {
		commands,
		context,
		emit,
		entries,
		messages,
		operations,
		notifications,
		sessionDir,
		setSessionId(value: string) {
			sessionId = value;
		},
	};
}

function assistantAt(contextTokens: number) {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: contextTokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: contextTokens,
			contextTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

describe("try-compact extension", () => {
	const tempDirs: TempDir[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const dir of tempDirs.splice(0)) await dir.remove();
	});

	it("round-trips editor settings and accepts commented key examples", () => {
		const text = formatSettingsDocument(DEFAULT_COMPACT_REMINDER_CONFIG);
		expect(parseSettingsDocument(text)).toEqual(DEFAULT_COMPACT_REMINDER_CONFIG);
		expect(
			parseSettingsDocument(
				text
					.replace("enabled=on", "#enabled=off")
					.replace("midremind=off", "#midremind=on")
					.replace("midremindstep=275k", "#midremindstep=150k"),
			),
		).toMatchObject({ enabled: false, midRemind: true, midRemindStepTokens: 150_000 });
	});

	it("accepts inclusive step boundaries and rejects values outside them", () => {
		const base = formatSettingsDocument(DEFAULT_COMPACT_REMINDER_CONFIG);
		expect(parseSettingsDocument(base.replace("midremindstep=275k", "midremindstep=1k")).midRemindStepTokens).toBe(
			1_000,
		);
		expect(parseSettingsDocument(base.replace("midremindstep=275k", "midremindstep=1m")).midRemindStepTokens).toBe(
			1_000_000,
		);
		expect(() => parseSettingsDocument(base.replace("midremindstep=275k", "midremindstep=1000001"))).toThrow();
	});

	it("rejects malformed editor settings atomically", () => {
		for (const edit of [
			"enabled=maybe\nmidremind=off\nmidremindstep=275k\n--- reminder instructions ---\nx",
			"enabled=on\nmidremind=off\nmidremindstep=999\n--- reminder instructions ---\nx",
			"enabled=on\nmidremind=off\nmidremindstep=275k\n--- reminder instructions ---\n",
			"enabled=on\nunknown=x\nmidremind=off\nmidremindstep=275k\n--- reminder instructions ---\nx",
		]) {
			expect(() => parseSettingsDocument(edit)).toThrow();
		}
	});

	it("advances checkpoints monotonically despite shake-style context drops", () => {
		expect(resolveMidReminderCheckpoint(274_999, 0, 275_000)).toBeUndefined();
		expect(resolveMidReminderCheckpoint(275_000, 0, 275_000)).toBe(275_000);
		expect(resolveMidReminderCheckpoint(275_000, 275_000, 275_000)).toBeUndefined();
		expect(resolveMidReminderCheckpoint(100_000, 275_000, 275_000)).toBeUndefined();
		expect(resolveMidReminderCheckpoint(550_000, 275_000, 275_000)).toBe(550_000);
		expect(resolveMidReminderCheckpoint(900_000, 550_000, 275_000)).toBe(825_000);
		expect(resolveMidReminderCheckpoint(700_000, 550_000, 150_000)).toBe(700_000);
	});

	it("persists the consumed step before sending and resets it on compaction", async () => {
		const entries = [
			{
				type: "custom",
				customType: CONFIG_ENTRY,
				data: { ...DEFAULT_COMPACT_REMINDER_CONFIG, midRemind: true },
			},
		];
		const harness = createHarness({ entries });
		tempDirs.push(harness.sessionDir);
		await harness.emit("session_start");

		await harness.emit("agent_end", { messages: [assistantAt(275_000)], willContinue: false });
		expect(harness.entries.at(-1)).toMatchObject({
			customType: MID_REMINDER_STATE_ENTRY,
			data: { sessionId: "session-a", lastCheckpointTokens: 275_000 },
		});
		expect(harness.messages).toHaveLength(1);
		expect(harness.operations.slice(-2)).toEqual([`append:${MID_REMINDER_STATE_ENTRY}`, "send"]);
		expect(harness.messages[0]).toMatchObject({
			message: {
				customType: "compact-reminder",
				display: true,
				attribution: "user",
				content: `[Compact reminder sent]\n${DEFAULT_COMPACT_REMINDER_CONFIG.instructions}`,
			},
			options: { triggerTurn: true, deliverAs: "followUp" },
		});

		await harness.emit("agent_end", { messages: [assistantAt(275_000)], willContinue: false });
		expect(harness.messages).toHaveLength(1);
		await harness.emit("agent_end", { messages: [assistantAt(550_000)], willContinue: false });
		expect(harness.messages).toHaveLength(2);

		await harness.emit("session_compact");
		expect(harness.entries.at(-1)).toMatchObject({
			customType: MID_REMINDER_STATE_ENTRY,
			data: { sessionId: "session-a", lastCheckpointTokens: 0 },
		});
		expect(harness.messages).toHaveLength(3);
		// Manual compaction has no original agent-end; suppress only its reminder-generated turn.
		await harness.emit("agent_end", { messages: [assistantAt(275_000)], willContinue: false });
		expect(harness.messages).toHaveLength(3);
		// Next ordinary turn proves reset rearmed the first checkpoint.
		await harness.emit("agent_end", { messages: [assistantAt(275_000)], willContinue: false });
		expect(harness.messages).toHaveLength(4);
	});

	it("does not consume a checkpoint while another continuation owns the turn", async () => {
		const entries: TestEntry[] = [
			{
				type: "custom",
				customType: CONFIG_ENTRY,
				data: { ...DEFAULT_COMPACT_REMINDER_CONFIG, midRemind: true },
			},
		];
		const harness = createHarness({ entries });
		tempDirs.push(harness.sessionDir);
		await harness.emit("session_start");
		await harness.emit("agent_end", { messages: [assistantAt(275_000)], willContinue: true });
		expect(harness.messages).toHaveLength(0);
		expect(harness.entries.some(entry => entry.customType === MID_REMINDER_STATE_ENTRY)).toBe(false);
		await harness.emit("agent_end", { messages: [assistantAt(275_000)], willContinue: false });
		expect(harness.messages).toHaveLength(1);
	});

	it("resets checkpoint state from an auto-compaction result without duplicate reminder", async () => {
		const entries: TestEntry[] = [
			{ type: "custom", customType: CONFIG_ENTRY, data: { ...DEFAULT_COMPACT_REMINDER_CONFIG, midRemind: true } },
			{
				type: "custom",
				customType: MID_REMINDER_STATE_ENTRY,
				data: { sessionId: "session-a", lastCheckpointTokens: 275_000 },
			},
		];
		const harness = createHarness({ entries });
		tempDirs.push(harness.sessionDir);
		await harness.emit("session_start");
		await harness.emit("auto_compaction_start", { action: "context-full", reason: "threshold" });
		await harness.emit("auto_compaction_end", { result: { summary: "done" }, aborted: false });
		expect(harness.entries.at(-1)).toMatchObject({
			customType: MID_REMINDER_STATE_ENTRY,
			data: { sessionId: "session-a", lastCheckpointTokens: 0 },
		});
		expect(harness.messages).toHaveLength(1);
	});

	it("pairs normal-order compaction events without a wall-clock window", async () => {
		const harness = createHarness({
			entries: [
				{
					type: "custom",
					customType: CONFIG_ENTRY,
					data: { ...DEFAULT_COMPACT_REMINDER_CONFIG, midRemind: true },
				},
			],
		});
		tempDirs.push(harness.sessionDir);
		const now = vi.spyOn(Date, "now");
		now.mockReturnValue(0);
		await harness.emit("session_start");
		await harness.emit("auto_compaction_start", { action: "context-full", reason: "threshold" });
		await harness.emit("session_compact");
		now.mockReturnValue(60_000);
		await harness.emit("auto_compaction_end", { result: { summary: "done" }, aborted: false });
		expect(harness.messages).toHaveLength(1);
		expect(harness.entries.filter(entry => entry.customType === MID_REMINDER_STATE_ENTRY)).toHaveLength(1);
		await harness.emit("agent_end", { messages: [assistantAt(275_000)], willContinue: false });
		expect(harness.messages).toHaveLength(1);
		await harness.emit("agent_end", { messages: [assistantAt(275_000)], willContinue: false });
		expect(harness.messages).toHaveLength(1);
		await harness.emit("agent_end", { messages: [assistantAt(275_000)], willContinue: false });
		expect(harness.messages).toHaveLength(2);
	});

	it("suppresses duplicate post-compaction reminders in either event order", async () => {
		const harness = createHarness();
		tempDirs.push(harness.sessionDir);
		await harness.emit("session_start");
		await harness.emit("auto_compaction_start", { action: "context-full", reason: "threshold" });
		await harness.emit("auto_compaction_end", { result: { summary: "done" }, aborted: false });
		await harness.emit("session_compact");
		expect(harness.messages).toHaveLength(1);
		expect(harness.entries.filter(entry => entry.customType === MID_REMINDER_STATE_ENTRY)).toHaveLength(1);
	});

	it("idle auto-compaction suppresses only the reminder-generated turn", async () => {
		const entries: TestEntry[] = [
			{ type: "custom", customType: CONFIG_ENTRY, data: { ...DEFAULT_COMPACT_REMINDER_CONFIG, midRemind: true } },
		];
		const harness = createHarness({ entries });
		tempDirs.push(harness.sessionDir);
		await harness.emit("session_start");
		await harness.emit("auto_compaction_start", { action: "context-full", reason: "idle" });
		await harness.emit("session_compact");
		await harness.emit("auto_compaction_end", { result: { summary: "done" }, aborted: false });
		expect(harness.messages).toHaveLength(1);
		await harness.emit("agent_end", { messages: [assistantAt(275_000)], willContinue: false });
		expect(harness.messages).toHaveLength(1);
		await harness.emit("agent_end", { messages: [assistantAt(275_000)], willContinue: false });
		expect(harness.messages).toHaveLength(2);
	});

	it("does not suppress two distinct rapid manual compactions", async () => {
		const harness = createHarness();
		tempDirs.push(harness.sessionDir);
		await harness.emit("session_start");
		await harness.emit("session_compact", { compactionEntry: { id: "one" } });
		await harness.emit("session_compact", { compactionEntry: { id: "two" } });
		expect(harness.messages).toHaveLength(2);
		expect(harness.entries.filter(entry => entry.customType === MID_REMINDER_STATE_ENTRY)).toHaveLength(2);
	});

	it("does not leak compaction suppression across session ids", async () => {
		const entries: TestEntry[] = [
			{ type: "custom", customType: CONFIG_ENTRY, data: { ...DEFAULT_COMPACT_REMINDER_CONFIG, midRemind: true } },
		];
		const harness = createHarness({ entries });
		tempDirs.push(harness.sessionDir);
		await harness.emit("session_start");
		await harness.emit("session_compact");
		expect(harness.messages).toHaveLength(1);

		harness.setSessionId("session-b");
		await harness.emit("session_switch");
		await harness.emit("agent_end", { messages: [assistantAt(275_000)], willContinue: false });
		expect(harness.messages).toHaveLength(2);
		expect(harness.entries.at(-1)).toMatchObject({
			customType: MID_REMINDER_STATE_ENTRY,
			data: { sessionId: "session-b", lastCheckpointTokens: 275_000 },
		});
	});

	it("restores persisted session checkpoint state after extension reload", async () => {
		const entries = [
			{
				type: "custom",
				customType: CONFIG_ENTRY,
				data: { ...DEFAULT_COMPACT_REMINDER_CONFIG, midRemind: true },
			},
			{
				type: "custom",
				customType: MID_REMINDER_STATE_ENTRY,
				data: { sessionId: "session-a", lastCheckpointTokens: 275_000 },
			},
		];
		const harness = createHarness({ entries });
		tempDirs.push(harness.sessionDir);
		await harness.emit("session_start");
		await harness.emit("agent_end", { messages: [assistantAt(275_000)], willContinue: false });
		expect(harness.messages).toHaveLength(0);
		await harness.emit("agent_end", { messages: [assistantAt(550_000)], willContinue: false });
		expect(harness.messages).toHaveLength(1);
	});

	it("isolates consumed checkpoints by session id", async () => {
		const entries: TestEntry[] = [
			{
				type: "custom",
				customType: CONFIG_ENTRY,
				data: { ...DEFAULT_COMPACT_REMINDER_CONFIG, midRemind: true },
			},
			{
				type: "custom",
				customType: MID_REMINDER_STATE_ENTRY,
				data: { sessionId: "session-a", lastCheckpointTokens: 275_000 },
			},
		];
		const harness = createHarness({ entries, sessionId: "session-b" });
		tempDirs.push(harness.sessionDir);
		await harness.emit("session_start");
		await harness.emit("agent_end", { messages: [assistantAt(275_000)], willContinue: false });
		expect(harness.messages).toHaveLength(1);
		expect(harness.entries.at(-1)).toMatchObject({
			customType: MID_REMINDER_STATE_ENTRY,
			data: { sessionId: "session-b", lastCheckpointTokens: 275_000 },
		});
	});

	it("defaults new sessions to enabled post-compaction and disabled mid-remind", async () => {
		const harness = createHarness();
		tempDirs.push(harness.sessionDir);
		await harness.commands.get("try-compact")!.handler("status", harness.context);
		expect(harness.notifications.at(-1)?.message).toContain(
			"enabled=on\nmidremind=off\nmidremindstep=275k\nlastmidremind=none\nnextmidremind=275k",
		);
	});

	it("reports live session settings and checkpoint state", async () => {
		const entries: TestEntry[] = [
			{
				type: "custom",
				customType: CONFIG_ENTRY,
				data: { ...DEFAULT_COMPACT_REMINDER_CONFIG, midRemind: true, midRemindStepTokens: 150_000 },
			},
			{
				type: "custom",
				customType: MID_REMINDER_STATE_ENTRY,
				data: { sessionId: "session-a", lastCheckpointTokens: 300_000 },
			},
		];
		const harness = createHarness({ entries });
		tempDirs.push(harness.sessionDir);
		await harness.commands.get("try-compact")!.handler("status", harness.context);
		expect(harness.notifications.at(-1)?.message).toContain(
			"enabled=on\nmidremind=on\nmidremindstep=150k\nlastmidremind=300k\nnextmidremind=450k",
		);
		expect(harness.commands.has("compact-remind")).toBe(true);
	});

	it("keeps prior live config when edited settings are invalid", async () => {
		const prior = {
			...DEFAULT_COMPACT_REMINDER_CONFIG,
			enabled: false,
			midRemind: true,
			midRemindStepTokens: 150_000,
			instructions: "Prior reminder",
		};
		const entries: TestEntry[] = [{ type: "custom", customType: CONFIG_ENTRY, data: prior }];
		const exec = vi.fn(async (_command: string, args: string[]) => {
			await Bun.write(args.at(-1)!, "enabled=maybe\n--- reminder instructions ---\nx");
			return { stdout: "", stderr: "", code: 0, killed: false };
		}) as unknown as ExtensionAPI["exec"];
		const harness = createHarness({ exec, entries });
		tempDirs.push(harness.sessionDir);
		const before = harness.entries.length;
		await harness.commands.get("try-compact")!.handler("settings", harness.context);
		expect(harness.entries).toHaveLength(before);
		expect(harness.notifications.at(-1)).toMatchObject({ level: "error" });
		await harness.commands.get("try-compact")!.handler("status", harness.context);
		expect(harness.notifications.at(-1)?.message).toContain("enabled=off\nmidremind=on\nmidremindstep=150k");
		expect(harness.notifications.at(-1)?.message).toContain("instructions=Prior reminder");
	});

	it("keeps prior live config when persistence fails after a valid edit", async () => {
		const prior = { ...DEFAULT_COMPACT_REMINDER_CONFIG, enabled: false, instructions: "Prior reminder" };
		const entries: TestEntry[] = [{ type: "custom", customType: CONFIG_ENTRY, data: prior }];
		const exec = vi.fn(async (_command: string, args: string[]) => {
			await Bun.write(
				args.at(-1)!,
				formatSettingsDocument({
					...DEFAULT_COMPACT_REMINDER_CONFIG,
					midRemind: true,
					instructions: "Unpersisted reminder",
				}),
			);
			return { stdout: "", stderr: "", code: 0, killed: false };
		}) as unknown as ExtensionAPI["exec"];
		const harness = createHarness({
			entries,
			exec,
			appendEntry(customType) {
				if (customType === CONFIG_ENTRY) throw new Error("injected persistence failure");
			},
		});
		tempDirs.push(harness.sessionDir);
		await harness.commands.get("try-compact")!.handler("settings", harness.context);
		await harness.commands.get("try-compact")!.handler("status", harness.context);
		expect(harness.notifications.at(-1)?.message).toContain("enabled=off");
		expect(harness.notifications.at(-1)?.message).toContain("instructions=Prior reminder");
		expect(harness.entries).toHaveLength(1);
	});

	it("opens settings editor and appends config only after valid parse", async () => {
		const exec = vi.fn(async (_command: string, args: string[]) => {
			const file = args.at(-1)!;
			await Bun.write(
				file,
				formatSettingsDocument({
					...DEFAULT_COMPACT_REMINDER_CONFIG,
					midRemind: true,
					midRemindStepTokens: 150_000,
					instructions: "Edited reminder",
				}),
			);
			return { stdout: "", stderr: "", code: 0, killed: false };
		}) as unknown as ExtensionAPI["exec"];
		const harness = createHarness({ exec });
		tempDirs.push(harness.sessionDir);
		await harness.emit("session_start");
		await harness.commands.get("try-compact")!.handler("settings", harness.context);
		expect(harness.entries.at(-1)).toMatchObject({
			customType: CONFIG_ENTRY,
			data: { enabled: true, midRemind: true, midRemindStepTokens: 150_000, instructions: "Edited reminder" },
		});
	});

	it("rejects malformed inline preset selectors", async () => {
		const harness = createHarness();
		tempDirs.push(harness.sessionDir);
		await Bun.write(
			path.join(harness.sessionDir.path(), "older.jsonl"),
			JSON.stringify({
				type: "custom",
				customType: CONFIG_ENTRY,
				data: { ...DEFAULT_COMPACT_REMINDER_CONFIG, instructions: "Preset" },
			}),
		);
		for (const selector of ["1junk", "1.5", "0", "999", "1 extra"]) {
			const before = harness.entries.length;
			await harness.commands.get("try-compact")!.handler(`load ${selector}`, harness.context);
			expect(harness.entries).toHaveLength(before);
			expect(harness.notifications.at(-1)).toMatchObject({ level: "warning" });
		}
	});

	it("ignores SELECT-like lines inside preset instructions", async () => {
		const exec = vi.fn(async () => ({
			stdout: "",
			stderr: "",
			code: 0,
			killed: false,
		})) as unknown as ExtensionAPI["exec"];
		const harness = createHarness({ exec });
		tempDirs.push(harness.sessionDir);
		await Bun.write(
			path.join(harness.sessionDir.path(), "older.jsonl"),
			JSON.stringify({
				type: "custom",
				customType: CONFIG_ENTRY,
				data: { ...DEFAULT_COMPACT_REMINDER_CONFIG, instructions: "Do not select.\nSELECT: 1" },
			}),
		);
		await harness.commands.get("try-compact")!.handler("load", harness.context);
		expect(harness.entries).toHaveLength(0);
		expect(harness.notifications.at(-1)).toMatchObject({ level: "warning" });
	});

	it("continues past 200 newer sessions without presets", async () => {
		const harness = createHarness();
		tempDirs.push(harness.sessionDir);
		await Promise.all(
			Array.from({ length: 205 }, (_, index) =>
				Bun.write(path.join(harness.sessionDir.path(), `z-${String(index).padStart(3, "0")}.jsonl`), "{}"),
			),
		);
		await Bun.write(
			path.join(harness.sessionDir.path(), "a-valid.jsonl"),
			JSON.stringify({
				type: "custom",
				customType: CONFIG_ENTRY,
				data: { ...DEFAULT_COMPACT_REMINDER_CONFIG, instructions: "Older valid preset" },
			}),
		);
		await harness.commands.get("try-compact")!.handler("load 1", harness.context);
		expect(harness.entries.at(-1)).toMatchObject({
			customType: CONFIG_ENTRY,
			data: { instructions: "Older valid preset" },
		});
	});

	it("loads a config preset from another project session", async () => {
		const harness = createHarness();
		tempDirs.push(harness.sessionDir);
		await Bun.write(
			path.join(harness.sessionDir.path(), "older.jsonl"),
			[
				JSON.stringify({ type: "session", timestamp: "2026-08-21T10:00:00.000Z", title: "Older task" }),
				JSON.stringify({
					type: "custom",
					customType: CONFIG_ENTRY,
					data: {
						enabled: false,
						midRemind: true,
						midRemindStepTokens: 150_000,
						instructions: "Preset reminder",
					},
				}),
			].join("\n"),
		);
		await harness.emit("session_start");
		await harness.commands.get("try-compact")!.handler("load 1", harness.context);
		expect(harness.entries.at(-1)).toMatchObject({
			customType: CONFIG_ENTRY,
			data: { enabled: false, midRemind: true, midRemindStepTokens: 150_000, instructions: "Preset reminder" },
		});
	});
});
