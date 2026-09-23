/**
 * Cross-process advisory lock for packages that serialize access to an
 * on-disk resource. New native addons provide process-owned OS locks. Every
 * process also takes a SQLite transaction lock, which is the compatibility
 * namespace when an older loaded addon does not export `FileLock`.
 */
import { Database } from "bun:sqlite";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { FileLock as NativeFileLock } from "@oh-my-pi/pi-natives";

/** Controls bounded waiting when an advisory file lock is contended. */
export interface FileLockOptions {
	/** Maximum acquisition attempts, including the initial attempt. */
	retries?: number;
	/** Delay between acquisition attempts. */
	retryDelayMs?: number;
	/** Cancel acquisition while waiting for another process to release the resource. */
	signal?: AbortSignal;
}

/** An exclusive advisory lease. Releasing an already released handle is safe. */
export interface FileLockHandle {
	release(): void;
}

interface AcquiredFileLockHandle extends FileLockHandle {
	readonly acquired: boolean;
}

interface FileLockConstructor {
	tryAcquire(lockPath: string): AcquiredFileLockHandle;
}

const DEFAULT_OPTIONS = {
	retries: 50,
	retryDelayMs: 100,
};

function getLockPath(filePath: string): string {
	return `${path.resolve(filePath)}.lock`;
}

function getCompatibilityDbPath(lockPath: string): string {
	return `${lockPath}.sqlite`;
}

function sqliteErrorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function isSqliteBusy(error: unknown): boolean {
	const code = sqliteErrorCode(error);
	if (code?.startsWith("SQLITE_BUSY") || code?.startsWith("SQLITE_LOCKED")) return true;
	return error instanceof Error && /database (?:is )?locked|database is busy/i.test(error.message);
}

class SqliteFileLock implements AcquiredFileLockHandle {
	readonly #database: Database;
	#acquired = true;

	constructor(database: Database) {
		this.#database = database;
	}

	get acquired(): boolean {
		return this.#acquired;
	}

	release(): void {
		if (!this.#acquired) return;
		this.#acquired = false;
		try {
			this.#database.run("COMMIT");
		} finally {
			this.#database.close(false);
		}
	}
}

function tryAcquireCompatibilityLock(lockPath: string): AcquiredFileLockHandle | null {
	let database: Database | undefined;
	try {
		database = new Database(getCompatibilityDbPath(lockPath), { create: true });
		database.run("PRAGMA busy_timeout = 0");
		database.run("BEGIN EXCLUSIVE");
		return new SqliteFileLock(database);
	} catch (error) {
		database?.close(false);
		if (isSqliteBusy(error)) return null;
		throw error;
	}
}

class CompositeFileLock implements AcquiredFileLockHandle {
	readonly #compatibility: AcquiredFileLockHandle;
	readonly #native: AcquiredFileLockHandle;
	#acquired = true;

	constructor(compatibility: AcquiredFileLockHandle, native: AcquiredFileLockHandle) {
		this.#compatibility = compatibility;
		this.#native = native;
	}

	get acquired(): boolean {
		return this.#acquired;
	}

	release(): void {
		if (!this.#acquired) return;
		this.#acquired = false;
		try {
			this.#compatibility.release();
		} finally {
			this.#native.release();
		}
	}
}

function createTryAcquire(
	nativeConstructor: FileLockConstructor | undefined,
): (lockPath: string) => AcquiredFileLockHandle | null {
	if (!nativeConstructor || typeof nativeConstructor.tryAcquire !== "function") {
		return tryAcquireCompatibilityLock;
	}
	return lockPath => {
		const native = nativeConstructor.tryAcquire(lockPath);
		if (!native.acquired) return null;
		try {
			const compatibility = tryAcquireCompatibilityLock(lockPath);
			if (compatibility) return new CompositeFileLock(compatibility, native);
			native.release();
			return null;
		} catch (error) {
			native.release();
			throw error;
		}
	};
}

// Runtime compatibility: generated TypeScript declarations can be newer than
// an already-loaded .node file after a source merge. Capability-check the value.
const tryAcquireLock = createTryAcquire(NativeFileLock as FileLockConstructor | undefined);

/** Acquire an exclusive lease; callers must release it when their operation ends. */
export async function acquireFileLock(filePath: string, options: FileLockOptions = {}): Promise<FileLockHandle> {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const lockPath = getLockPath(filePath);

	for (let attempt = 0; attempt < opts.retries; attempt++) {
		opts.signal?.throwIfAborted();
		const lock = tryAcquireLock(lockPath);
		if (lock) return lock;
		if (attempt + 1 < opts.retries) await scheduler.wait(opts.retryDelayMs, { signal: opts.signal });
	}

	throw new Error(`Failed to acquire lock for ${filePath} after ${opts.retries} attempts`);
}

function acquireLockSync(filePath: string, options: FileLockOptions = {}): FileLockHandle {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const lockPath = getLockPath(filePath);

	for (let attempt = 0; attempt < opts.retries; attempt++) {
		opts.signal?.throwIfAborted();
		const lock = tryAcquireLock(lockPath);
		if (lock) return lock;
		if (attempt + 1 < opts.retries && opts.retryDelayMs > 0) Bun.sleepSync(opts.retryDelayMs);
	}

	throw new Error(`Failed to acquire lock for ${filePath} after ${opts.retries} attempts`);
}

/** Run `fn` while holding an exclusive lock for `filePath`. */
export async function withFileLock<T>(
	filePath: string,
	fn: () => Promise<T>,
	options: FileLockOptions = {},
): Promise<T> {
	const lock = await acquireFileLock(filePath, options);
	try {
		return await fn();
	} finally {
		lock.release();
	}
}

/** Run synchronous `fn` while holding an exclusive lock for `filePath`. */
export function withFileLockSync<T>(filePath: string, fn: () => T, options: FileLockOptions = {}): T {
	const lock = acquireLockSync(filePath, options);
	try {
		return fn();
	} finally {
		lock.release();
	}
}

/** Test-only lock seams. Not part of the supported package API. */
export const __internalsForTesting = {
	createTryAcquire,
	tryAcquireCompatibilityLock,
	tryAcquireLock,
	getCompatibilityDbPath,
	getLockPath,
};
