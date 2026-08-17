import { describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	ACP_BUILTIN_SLASH_COMMANDS,
	executeAcpBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

function createRuntime() {
	const output = vi.fn();
	const settings = Settings.isolated();
	let enabled = false;
	const setTryShakeEnabled = vi.fn((value: boolean) => {
		enabled = value;
	});
	const runtime = {
		settings,
		output,
		session: { setTryShakeEnabled, isTryShakeEnabled: () => enabled },
	} as unknown as SlashCommandRuntime;
	return { output, runtime, setTryShakeEnabled, isEnabled: () => enabled };
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
		expect(h.output).toHaveBeenLastCalledWith("Try-shake is disabled for this session.");
		expect(h.setTryShakeEnabled).not.toHaveBeenCalled();

		await executeAcpBuiltinSlashCommand("/tryshake on", h.runtime);
		await executeAcpBuiltinSlashCommand("/tryshake status", h.runtime);
		expect(h.output).toHaveBeenLastCalledWith("Try-shake is enabled for this session.");
		expect(h.setTryShakeEnabled).toHaveBeenCalledTimes(1);
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
			expect(h.output).toHaveBeenCalledWith("Usage: /tryshake [on|off|status]");
		}
	});

	it("is advertised to ACP clients with on, off, and status subcommands", () => {
		const advertised = ACP_BUILTIN_SLASH_COMMANDS.find(command => command.name === "tryshake");
		expect(advertised).toBeDefined();
		expect(advertised?.input?.hint).toBe("[on|off|status]");
	});
});
