import { beforeAll, describe, expect, it, vi } from "bun:test";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

interface RenderableBlock {
	render(width: number): string[];
}

function isRenderableBlock(value: unknown): value is RenderableBlock {
	return value !== null && typeof value === "object" && "render" in value && typeof value.render === "function";
}

function renderPresentedBlocks(value: unknown): string {
	const blocks = Array.isArray(value) ? value : [value];
	return blocks
		.filter(isRenderableBlock)
		.flatMap(block => block.render(120))
		.join("\n");
}

const zeroTokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const zeroMessages = { user: 0, assistant: 0, total: 0 };

describe("CommandController /advisor status", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	it("renders a separate tools section for every advisor in roster view", async () => {
		const present = vi.fn();
		const stats = {
			configured: true,
			active: true,
			contextWindow: 272_000,
			contextTokens: 0,
			tokens: zeroTokens,
			cost: 0,
			messages: zeroMessages,
			tools: [
				{ name: "edit", successful: 1, attempts: 2 },
				{ name: "learn", successful: 2, attempts: 3 },
			],
			advisors: [
				{
					name: "default",
					status: "paused",
					contextWindow: 0,
					contextTokens: 0,
					tokens: zeroTokens,
					cost: 0,
					messages: zeroMessages,
					tools: [],
					source: { scope: "project", path: "C:\\repo\\WATCHDOG.yml" },
				},
				{
					name: "Memory Advisor",
					status: "running",
					model: { provider: "openai-codex", id: "gpt-5.6" },
					contextWindow: 272_000,
					contextTokens: 0,
					tokens: zeroTokens,
					cost: 0,
					messages: zeroMessages,
					tools: [{ name: "learn", successful: 2, attempts: 3 }],
					source: { scope: "user", path: "C:\\agent\\WATCHDOG.yml" },
				},
				{
					name: "Security Advisor",
					status: "running",
					model: { provider: "openai-codex", id: "gpt-5.6" },
					contextWindow: 272_000,
					contextTokens: 0,
					tokens: zeroTokens,
					cost: 0,
					messages: zeroMessages,
					tools: [{ name: "edit", successful: 1, attempts: 2 }],
					source: { scope: "project", path: "C:\\repo\\WATCHDOG.yml" },
				},
			],
		};
		const ctx = {
			session: { getAdvisorStats: () => stats },
			ui: { terminal: { columns: 100 } },
			presentCommandOutput: present,
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);

		await controller.handleAdvisorStatusCommand();

		const output = renderPresentedBlocks(present.mock.calls[0]?.[0]);
		expect(output.split("Tools usage")).toHaveLength(4);
		const memoryStart = output.indexOf("Memory Advisor");
		const securityStart = output.indexOf("Security Advisor");
		expect(output.indexOf("No tools called.")).toBeLessThan(memoryStart);
		expect(output.indexOf("learn: 2/3")).toBeGreaterThan(memoryStart);
		expect(output.indexOf("learn: 2/3")).toBeLessThan(securityStart);
		expect(output.indexOf("edit: 1/2")).toBeGreaterThan(securityStart);
	});
});
