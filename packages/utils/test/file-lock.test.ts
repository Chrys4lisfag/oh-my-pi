import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { __internalsForTesting, withFileLock } from "../src/file-lock";
import { isEnoent } from "../src/fs-error";
import { removeWithRetries } from "../src/temp";

const { createTryAcquire, tryAcquireCompatibilityLock, tryAcquireLock, getLockPath } = __internalsForTesting;

const ROOTS: string[] = [];

async function mkRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "filelock-test-"));
	ROOTS.push(root);
	return root;
}

afterAll(async () => {
	for (const root of ROOTS) {
		await removeWithRetries(root).catch(() => {});
	}
});

describe("file-lock ownership", () => {
	test("falls back when the loaded native addon has no FileLock export", async () => {
		const root = await mkRoot();
		const lockPath = getLockPath(path.join(root, "missing-native.json"));
		const acquire = createTryAcquire(undefined);
		const owner = acquire(lockPath);
		if (!owner) throw new Error("compatibility fallback failed to acquire");
		expect(acquire(lockPath)).toBeNull();
		owner.release();
		const successor = acquire(lockPath);
		if (!successor) throw new Error("compatibility fallback failed after release");
		successor.release();
	});

	test("missing-native and native-present processes share the compatibility namespace", async () => {
		const root = await mkRoot();
		const lockPath = getLockPath(path.join(root, "mixed-native.json"));
		let nativeHeld = false;
		const nativeConstructor = {
			tryAcquire: () => {
				const acquired = !nativeHeld;
				if (acquired) nativeHeld = true;
				return {
					acquired,
					release: () => {
						if (acquired) nativeHeld = false;
					},
				};
			},
		};
		const fallbackAcquire = createTryAcquire(undefined);
		const compositeAcquire = createTryAcquire(nativeConstructor);

		const fallbackOwner = fallbackAcquire(lockPath);
		if (!fallbackOwner) throw new Error("fallback owner failed to acquire");
		expect(compositeAcquire(lockPath)).toBeNull();
		expect(nativeHeld).toBe(false);
		fallbackOwner.release();

		const compositeOwner = compositeAcquire(lockPath);
		if (!compositeOwner) throw new Error("composite owner failed to acquire");
		expect(fallbackAcquire(lockPath)).toBeNull();
		compositeOwner.release();
		const finalOwner = fallbackAcquire(lockPath);
		expect(finalOwner).not.toBeNull();
		finalOwner?.release();
	});

	test("compatibility lock late release cannot unlock its successor", async () => {
		const root = await mkRoot();
		const lockPath = getLockPath(path.join(root, "compatibility-handoff.json"));
		const formerOwner = tryAcquireCompatibilityLock(lockPath);
		if (!formerOwner) throw new Error("former compatibility owner failed to acquire");
		formerOwner.release();
		const successor = tryAcquireCompatibilityLock(lockPath);
		if (!successor) throw new Error("compatibility successor failed to acquire");
		formerOwner.release();
		expect(tryAcquireCompatibilityLock(lockPath)).toBeNull();
		successor.release();
	});

	test("process death hands ownership to B while excluding C", async () => {
		const root = await mkRoot();
		const target = path.join(root, "abandoned.json");
		const readyPath = path.join(root, "holder-ready");
		const lockPath = getLockPath(target);
		const holder = Bun.spawn(
			[process.execPath, path.join(import.meta.dir, "fixtures/file-lock-holder.ts"), target, readyPath],
			{
				cwd: path.resolve(import.meta.dir, "../../.."),
				env: { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "" },
				stdin: "ignore",
				stdout: "ignore",
				stderr: "pipe",
			},
		);

		try {
			for (;;) {
				try {
					await fs.access(readyPath);
					break;
				} catch (error) {
					if (!isEnoent(error)) throw error;
					if (holder.exitCode !== null) {
						throw new Error(
							`lock holder exited before readiness (${holder.exitCode}): ${await new Response(holder.stderr).text()}`,
						);
					}
				}
			}

			holder.kill();
			expect(await holder.exited).not.toBe(0);

			const ownerB = tryAcquireLock(lockPath);
			if (!ownerB) throw new Error("B failed to acquire the abandoned lock");
			const ownerC = tryAcquireLock(lockPath);
			expect(ownerC).toBeNull();
			expect(ownerB.acquired).toBe(true);
			ownerB.release();
		} finally {
			if (holder.exitCode === null) {
				holder.kill();
				await holder.exited;
			}
		}
	}, 10_000);

	test("a former owner's late release cannot unlock its successor", async () => {
		const root = await mkRoot();
		const lockPath = getLockPath(path.join(root, "handoff.json"));
		const formerOwner = tryAcquireLock(lockPath);
		if (!formerOwner) throw new Error("former owner failed to acquire");
		formerOwner.release();

		const successor = tryAcquireLock(lockPath);
		if (!successor) throw new Error("successor failed to acquire");

		// Force the old release path after the successor owns the same name.
		formerOwner.release();
		expect(tryAcquireLock(lockPath)).toBeNull();
		expect(successor.acquired).toBe(true);

		successor.release();
		const finalOwner = tryAcquireLock(lockPath);
		if (!finalOwner) throw new Error("final owner failed to acquire");
		finalOwner.release();
	});

	test("withFileLock serializes N concurrent writers without lost updates", async () => {
		const root = await mkRoot();
		const target = path.join(root, "counter.json");
		await fs.writeFile(target, JSON.stringify({ counter: 0 }));

		const N = 30;
		await Promise.all(
			Array.from({ length: N }, () =>
				withFileLock(
					target,
					async () => {
						const text = await fs.readFile(target, "utf-8");
						const data = JSON.parse(text) as { counter: number };
						data.counter += 1;
						await Promise.resolve();
						await fs.writeFile(target, JSON.stringify(data));
					},
					{ retries: 500, retryDelayMs: 5 },
				),
			),
		);

		const text = await fs.readFile(target, "utf-8");
		const final = JSON.parse(text) as { counter: number };
		expect(final.counter).toBe(N);
	}, 30_000);
});
