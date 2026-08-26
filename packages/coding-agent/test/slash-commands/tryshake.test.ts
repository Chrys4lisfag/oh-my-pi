import { describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	ACP_BUILTIN_SLASH_COMMANDS,
	executeAcpBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { BUILTIN_LIFECYCLE_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-lifecycle";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

function createRuntime() {
	const output = vi.fn();
	const settings = Settings.isolated();
	let enabled = false;
	let stepTokens = 150_000;
	let nextTokens = 275_000;
	const setTryShakeEnabled = vi.fn((value: boolean) => {
		enabled = value;
	});
	const setTryShakeCheckpointStepTokens = vi.fn((value: number) => {
		if (value < 1_000 || value > 1_000_000) throw new RangeError("step out of range");
		stepTokens = value;
	});
	const runtime = {
		settings,
		output,
		session: {
			setTryShakeEnabled,
			isTryShakeEnabled: () => enabled,
			setTryShakeCheckpointStepTokens,
			getTryShakeCheckpointStepTokens: () => stepTokens,
			getNextTryShakeCheckpointTokens: () => nextTokens,
		},
	} as unknown as SlashCommandRuntime;
	return {
		output,
		runtime,
		setTryShakeEnabled,
		setTryShakeCheckpointStepTokens,
		isEnabled: () => enabled,
		stepTokens: () => stepTokens,
		setNextTokens: (value: number) => {
			nextTokens = value;
		},
	};
}

describe("/tryshake slash command", () => {
	it("defaults to disabled for each session", () => {
		expect(createRuntime().isEnabled()).toBe(false);
		expect(createRuntime().isEnabled()).toBe(false);
	});

	it("toggles only current session state", async () => {
		const h = createRuntime();

		expect(await executeAcpBuiltinSlashCommand("/tryshake on", h.runtime)).toEqual({ consumed: true });
		expect(h.isEnabled()).toBe(true);
		expect(h.setTryShakeEnabled).toHaveBeenLastCalledWith(true);
		expect(h.output).toHaveBeenLastCalledWith("Try-shake enabled for this session.");

		await executeAcpBuiltinSlashCommand("/tryshake off", h.runtime);
		expect(h.isEnabled()).toBe(false);
		expect(h.setTryShakeEnabled).toHaveBeenLastCalledWith(false);
		expect(h.output).toHaveBeenLastCalledWith("Try-shake disabled for this session.");
	});

	it("reports current session status without changing it", async () => {
		const h = createRuntime();

		await executeAcpBuiltinSlashCommand("/tryshake status", h.runtime);
		expect(h.output).toHaveBeenLastCalledWith(
			"Try-shake is disabled for this session. First: 275k; step: 150k; next: 275k.",
		);
		expect(h.setTryShakeEnabled).not.toHaveBeenCalled();

		await executeAcpBuiltinSlashCommand("/tryshake on", h.runtime);
		await executeAcpBuiltinSlashCommand("/tryshake step 200k", h.runtime);
		h.setNextTokens(425_000);
		await executeAcpBuiltinSlashCommand("/tryshake status", h.runtime);
		expect(h.output).toHaveBeenLastCalledWith(
			"Try-shake is enabled for this session. First: 275k; step: 200k; next: 425k.",
		);
		expect(h.setTryShakeEnabled).toHaveBeenCalledTimes(1);
	});

	it("configures checkpoint step with plain, k, and m token amounts", async () => {
		const h = createRuntime();
		for (const [command, expected] of [
			["/tryshake step 200000", 200_000],
			["/tryshake step 175k", 175_000],
			["/tryshake step 0.2m", 200_000],
			["/tryshake step 1k", 1_000],
			["/tryshake step 1m", 1_000_000],
		] as const) {
			expect(await executeAcpBuiltinSlashCommand(command, h.runtime)).toEqual({ consumed: true });
			expect(h.stepTokens()).toBe(expected);
			expect(h.setTryShakeCheckpointStepTokens).toHaveBeenLastCalledWith(expected);
		}
		expect(h.output).toHaveBeenLastCalledWith("Try-shake checkpoint step set to 1m for this session.");
	});

	it("rejects malformed and out-of-range checkpoint steps", async () => {
		const malformed = createRuntime();
		expect(await executeAcpBuiltinSlashCommand("/tryshake step nope", malformed.runtime)).toEqual({
			consumed: true,
		});
		expect(malformed.setTryShakeCheckpointStepTokens).not.toHaveBeenCalled();
		expect(malformed.output).toHaveBeenCalledWith("Usage: /tryshake step <tokens> (for example 150k)");

		for (const [command, parsed] of [
			["/tryshake step 999", 999],
			["/tryshake step 1000001", 1_000_001],
			["/tryshake step 2m", 2_000_000],
		] as const) {
			const h = createRuntime();
			expect(await executeAcpBuiltinSlashCommand(command, h.runtime)).toEqual({ consumed: true });
			expect(h.setTryShakeCheckpointStepTokens).toHaveBeenCalledWith(parsed);
			expect(h.stepTokens()).toBe(150_000);
			expect(h.output).toHaveBeenCalledWith("step out of range");
		}
	});

	it("normalizes command argument case", async () => {
		const h = createRuntime();
		await executeAcpBuiltinSlashCommand("/tryshake ON", h.runtime);
		expect(h.isEnabled()).toBe(true);
	});

	it("rejects bare and unknown arguments without changing session state", async () => {
		for (const command of ["/tryshake", "/tryshake maybe"]) {
			const h = createRuntime();
			await executeAcpBuiltinSlashCommand(command, h.runtime);
			expect(h.isEnabled()).toBe(false);
			expect(h.setTryShakeEnabled).not.toHaveBeenCalled();
			expect(h.output).toHaveBeenCalledWith("Usage: /tryshake [on|off|status|step <tokens>]");
		}
	});

	it("advertises step argument metadata to ACP and TUI clients", () => {
		const advertised = ACP_BUILTIN_SLASH_COMMANDS.find(command => command.name === "tryshake");
		expect(advertised).toBeDefined();
		expect(advertised?.input?.hint).toBe("[on|off|status|step <tokens>]");
		const lifecycle = BUILTIN_LIFECYCLE_SLASH_COMMANDS.find(command => command.name === "tryshake");
		expect(lifecycle?.subcommands?.find(subcommand => subcommand.name === "step")).toMatchObject({
			description: expect.stringContaining("checkpoint spacing"),
			usage: "<tokens>",
		});
	});
});
