import { afterEach, describe, expect, it } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const PROFILE_NAME = "gpt-edu";

function profileSnapshot() {
	return {
		modelRoles: {
			default: "anthropic/claude-sonnet-4-5",
			smol: "anthropic/claude-haiku-4-5",
		},
		defaultThinkingLevel: "high",
	};
}

const managers: SessionManager[] = [];
const tempDirs: TempDir[] = [];

function track(manager: SessionManager): SessionManager {
	managers.push(manager);
	return manager;
}

function makeTempDir(): TempDir {
	const tempDir = TempDir.createSync("@pi-session-profile-fork-");
	tempDirs.push(tempDir);
	return tempDir;
}

function expectProfile(manager: SessionManager): void {
	const snapshot = profileSnapshot();
	expect(manager.getSessionProfile()).toBe(PROFILE_NAME);
	expect(manager.getSessionProfileSnapshot()).toEqual(snapshot);
	expect(manager.getHeader()).toMatchObject({
		profile: PROFILE_NAME,
		profileSnapshot: snapshot,
	});
}

async function expectPersistedProfile(sessionFile: string): Promise<void> {
	const reopened = track(await SessionManager.open(sessionFile));
	expectProfile(reopened);
}

afterEach(async () => {
	await Promise.all(managers.splice(0).map(manager => manager.close()));
	await Promise.all(tempDirs.splice(0).map(tempDir => tempDir.remove()));
});

describe("SessionManager profile persistence across session copies", () => {
	it("preserves profile and profileSnapshot in a branched session", async () => {
		const tempDir = makeTempDir();
		const manager = track(SessionManager.create(tempDir.path(), tempDir.path()));
		await manager.setSessionProfile(PROFILE_NAME, profileSnapshot());
		const branchPoint = manager.appendMessage({ role: "user", content: "branch here", timestamp: 1 });
		await manager.ensureOnDisk();

		const branchedSessionFile = manager.createBranchedSession(branchPoint);

		if (!branchedSessionFile) throw new Error("Expected persisted branched session file");
		expectProfile(manager);
		await expectPersistedProfile(branchedSessionFile);
	});

	it("preserves profile and profileSnapshot in a forked session", async () => {
		const tempDir = makeTempDir();
		const manager = track(SessionManager.create(tempDir.path(), tempDir.path()));
		await manager.setSessionProfile(PROFILE_NAME, profileSnapshot());
		manager.appendMessage({ role: "user", content: "fork this", timestamp: 1 });
		await manager.ensureOnDisk();

		const fork = await manager.fork();

		if (!fork) throw new Error("Expected persisted fork");
		expect(fork.newSessionFile).not.toBe(fork.oldSessionFile);
		expectProfile(manager);
		await expectPersistedProfile(fork.newSessionFile);
	});

	it("preserves profile and profileSnapshot when persisting an in-memory copy", async () => {
		const tempDir = makeTempDir();
		const source = track(SessionManager.inMemory(tempDir.path()));
		await source.setSessionProfile(PROFILE_NAME, profileSnapshot());
		source.appendMessage({ role: "user", content: "persist this copy", timestamp: 1 });

		const copy = track(
			await source.persistCopy({
				sessionDir: tempDir.path(),
				suppressBreadcrumb: true,
			}),
		);

		expectProfile(source);
		expectProfile(copy);
		const copiedSessionFile = copy.getSessionFile();
		if (!copiedSessionFile) throw new Error("Expected persisted copy session file");
		await expectPersistedProfile(copiedSessionFile);
	});

	it("marks legacy forks and persisted copies as derived instead of fresh", async () => {
		const tempDir = makeTempDir();
		const source = track(SessionManager.create(tempDir.path(), tempDir.path()));
		source.appendMessage({ role: "user", content: "legacy history", timestamp: 1 });
		await source.ensureOnDisk();
		const sourceFile = source.getSessionFile();
		if (!sourceFile) throw new Error("Expected legacy source session file");

		const fork = track(await SessionManager.forkFrom(sourceFile, tempDir.path(), tempDir.path()));
		const copy = track(
			await source.persistCopy({
				sessionDir: tempDir.path(),
				suppressBreadcrumb: true,
			}),
		);

		for (const derived of [fork, copy]) {
			expect(derived.hasLoadedExistingSession()).toBe(true);
			expect(derived.getSessionProfile()).toBeUndefined();
			expect(derived.getSessionProfileSnapshot()).toBeUndefined();
		}
	});
});
