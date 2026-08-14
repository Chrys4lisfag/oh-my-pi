import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const emptyParameters = type({});
const recallTool: AgentTool<typeof emptyParameters, undefined> = {
	name: "recall",
	label: "Recall",
	description: "Recall long-term memory",
	parameters: emptyParameters,
	execute: async () => ({ content: [{ type: "text", text: "none" }], details: undefined }),
};

const memoryInstructions = `You are a Memory Adviser. For every substantive task, you MUST call recall.
Use reflect for cross-session patterns and learn only verified lessons.`;

describe("advisor memory reminder integration", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-advisor-memory-reminder-");
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		await tempDir.remove();
	});

	it("injects the instruction artifact on the eighth context read without recall", async () => {
		const primaryMock = createMockModel({
			provider: "anthropic",
			responses: Array.from({ length: 8 }, () => ({ content: ["primary complete"] })),
		});
		const advisorMock = createMockModel({
			provider: "anthropic",
			responses: Array.from({ length: 8 }, () => ({ content: ["advisor reviewed"] })),
		});
		const roleModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!roleModel) throw new Error("Expected advisor role model");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const settings = Settings.isolated({
			"advisor.enabled": true,
			"advisor.syncBacklog": "1",
			"compaction.enabled": false,
		});
		settings.setModelRole("advisor", `${roleModel.provider}/${roleModel.id}`);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: primaryMock, systemPrompt: ["Test"], tools: [] },
			streamFn: primaryMock.stream,
		});
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			advisorTools: [recallTool as AgentTool],
			advisorConfigs: [
				{
					name: "Memory Advisor",
					tools: ["recall"],
					instructions: memoryInstructions,
				},
			],
			advisorStreamFn: advisorMock.stream,
		});
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected memory advisor runtime");
		advisor.setModel(advisorMock);
		expect(session.getAdvisorStats().memoryReminderInjections).toBe(0);
		expect(session.getAdvisorStats().advisors[0]?.memoryReminderInjections).toBe(0);

		for (let index = 0; index < 8; index++) {
			await session.prompt(`primary update ${index + 1}`);
			expect(await session.waitForAdvisorCatchup(2_000)).toBe(true);
		}

		expect(advisorMock.calls).toHaveLength(8);
		for (const call of advisorMock.calls.slice(0, 7)) {
			expect(JSON.stringify(call.context.messages)).not.toContain("advisor-memory-reminder");
		}
		const eighthContext = JSON.stringify(advisorMock.calls[7].context.messages);
		expect(eighthContext).toContain("advisor-memory-reminder");
		expect(eighthContext).toContain("MUST use `recall`");
		expect(eighthContext).toContain("artifact://");

		const stats = session.getAdvisorStats();
		expect(stats.memoryReminderInjections).toBe(1);
		expect(stats.advisors[0]?.memoryReminderInjections).toBe(1);
		expect(session.formatAdvisorStatus()).toContain("Memory reminder injections: 1");

		session.refreshAdvisors();
		const rebuiltStats = session.getAdvisorStats();
		expect(rebuiltStats.memoryReminderInjections).toBe(1);
		expect(rebuiltStats.advisors[0]?.memoryReminderInjections).toBe(1);

		const artifactsDir = sessionManager.getArtifactsDir();
		if (!artifactsDir) throw new Error("Expected persisted artifact directory");
		const artifactFiles = await fs.readdir(artifactsDir);
		const artifactContents = await Promise.all(
			artifactFiles.map(file => fs.readFile(`${artifactsDir}/${file}`, "utf8")),
		);
		expect(artifactContents.some(content => content.includes(memoryInstructions))).toBe(true);
	});
});
