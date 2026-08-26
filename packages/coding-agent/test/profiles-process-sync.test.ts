import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const CHILD_SOURCE = `
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const agentDir = process.argv[1];
const mode = process.argv[2];
const settings = await Settings.loadIsolated({ agentDir });
const authStorage = await AuthStorage.create(agentDir + "/auth-" + mode + ".db");
authStorage.setRuntimeApiKey("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage);
const model = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Expected bundled profile process model");
const session = new AgentSession({
  agent: new Agent({ initialState: { model, thinkingLevel: "high", systemPrompt: ["Test"], tools: [], messages: [] } }),
  sessionManager: SessionManager.inMemory(),
  settings,
  thinkingLevel: "high",
  modelRegistry,
});
console.log(JSON.stringify({
  event: "ready",
  pid: process.pid,
  active: settings.get("profiles.active"),
  level: settings.get("defaultThinkingLevel"),
  item: settings.get("profiles.items")["gpt-edu"]?.defaultThinkingLevel,
  sessionLevel: session.thinkingLevel ?? null,
}));

if (mode === "writer") {
  session.setThinkingLevel("medium", true);
  await settings.flush();
  console.log(JSON.stringify({
    event: "written",
    pid: process.pid,
    level: settings.get("defaultThinkingLevel"),
    item: settings.get("profiles.items")["gpt-edu"]?.defaultThinkingLevel,
    sessionLevel: session.thinkingLevel,
  }));
} else {
  const deadline = Date.now() + 5_000;
  while (settings.get("defaultThinkingLevel") !== "medium" && Date.now() < deadline) {
    await Bun.sleep(50);
  }
  await session.waitForIdle();
  console.log(JSON.stringify({
    event: "observed",
    pid: process.pid,
    level: settings.get("defaultThinkingLevel"),
    item: settings.get("profiles.items")["gpt-edu"]?.defaultThinkingLevel,
    sessionLevel: session.thinkingLevel,
  }));
}

await session.dispose();
await settings.dispose();
authStorage.close();
`;

type ChildEvent = {
	event: "ready" | "written" | "observed";
	pid: number;
	active?: string;
	level: string;
	item: string;
	sessionLevel: string | null;
};

function createLineReader(stream: ReadableStream<Uint8Array>) {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	return async (timeoutMs = 10_000): Promise<ChildEvent> => {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const newline = buffered.indexOf("\n");
			if (newline >= 0) {
				const line = buffered.slice(0, newline);
				buffered = buffered.slice(newline + 1);
				return JSON.parse(line) as ChildEvent;
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error("Timed out waiting for settings child output");
			const result = await Promise.race([
				reader.read(),
				Bun.sleep(remaining).then(() => ({ timeout: true }) as const),
			]);
			if ("timeout" in result) throw new Error("Timed out waiting for settings child output");
			if (result.done) throw new Error(`Settings child exited before emitting a complete line: ${buffered}`);
			buffered += decoder.decode(result.value, { stream: true });
		}
	};
}

describe("profile synchronization across OS processes", () => {
	const children: Bun.Subprocess[] = [];

	afterEach(async () => {
		for (const child of children.splice(0)) {
			if (child.exitCode === null) child.kill();
			await child.exited;
		}
	});

	it("propagates a same-profile high-to-medium edit through the real file watcher", async () => {
		const tempDir = TempDir.createSync("@pi-profile-process-sync-");
		const configPath = path.join(tempDir.path(), "config.yml");
		try {
			await Bun.write(
				configPath,
				[
					"profiles:",
					"  active: gpt-edu",
					"  items:",
					"    gpt-edu:",
					"      modelRoles:",
					"        default: anthropic/claude-sonnet-4-5",
					"      defaultThinkingLevel: high",
					"modelRoles:",
					"  default: anthropic/claude-sonnet-4-5",
					"defaultThinkingLevel: high",
				].join("\n"),
			);

			const spawnChild = (mode: "writer" | "peer") => {
				const child = Bun.spawn([process.execPath, "-e", CHILD_SOURCE, tempDir.path(), mode], {
					cwd: path.join(import.meta.dir, ".."),
					stdout: "pipe",
					stderr: "inherit",
				});
				children.push(child);
				return { child, nextLine: createLineReader(child.stdout) };
			};

			const peer = spawnChild("peer");
			const peerReady = await peer.nextLine();
			expect(peerReady).toMatchObject({
				event: "ready",
				active: "gpt-edu",
				level: "high",
				item: "high",
				sessionLevel: "high",
			});

			const writer = spawnChild("writer");
			const writerReady = await writer.nextLine();
			const written = await writer.nextLine();
			expect(writerReady).toMatchObject({
				event: "ready",
				active: "gpt-edu",
				level: "high",
				item: "high",
				sessionLevel: "high",
			});
			expect(written).toMatchObject({ event: "written", level: "medium", item: "medium", sessionLevel: "medium" });
			expect(written.pid).not.toBe(peerReady.pid);
			expect(await writer.child.exited).toBe(0);

			const observed = await peer.nextLine();
			expect(observed).toMatchObject({ event: "observed", level: "medium", item: "medium", sessionLevel: "medium" });
			expect(await peer.child.exited).toBe(0);
			expect(await Bun.file(configPath).text()).toContain("defaultThinkingLevel: medium");
		} finally {
			for (const child of children.splice(0)) {
				if (child.exitCode === null) child.kill();
				await child.exited;
			}
			await tempDir.remove();
		}
	}, 15_000);
});
