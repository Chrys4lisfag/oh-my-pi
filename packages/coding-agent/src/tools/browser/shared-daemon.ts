/**
 * Shared automation Chromium owned by a project or machine-global daemon broker.
 * Sessions acquire broker leases and open independent tabs. The global scope
 * retains an OMP-owned disk profile across broker restarts, never a personal
 * Chrome profile. Headed and headless daemons have separate profiles so two
 * Chromium processes cannot contend for one profile lock.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { daemonClientForGlobal, daemonClientForProject } from "../../launch/client";
import { describeQuietly, stopQuietly, waitReady } from "../../launch/ensure";
import { daemonRuntimeDir } from "../../launch/paths";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import { throwIfAborted } from "../tool-errors";
import { probeCdpStatus } from "./attach";
import { resolveSharedBrowserLaunchSpec } from "./launch";

/** Chrome prints this on stderr once the CDP listener is up; the broker's ready probe captures the line. */
const READY_LOG_PATTERN = String.raw`DevTools listening on ws://\S+`;
const READY_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 1_500;
/** describe→start rounds before giving up; bounds cross-process start races and wedged-Chrome replacement. */
const ENSURE_ATTEMPTS = 3;
const GLOBAL_BROWSER_SCOPE = "browser-state";

/** Broker-owned browser endpoint one omp process can attach to. */
export interface SharedBrowserEndpoint {
	wsEndpoint: string;
	daemonName: string;
	/** Canonical broker scope: project directory or global service directory. */
	projectDir: string;
	/** Actual broker runtime directory, also used for durable target ownership. */
	runtimeDir: string;
}

/** Stable broker daemon name for the shared automation browser. */
export function sharedBrowserDaemonName(headless: boolean): string {
	return headless ? "omp.browser.headless" : "omp.browser.headed";
}

function wsEndpointOf(snapshot: DaemonSnapshot | undefined): string | undefined {
	return snapshot?.readyMatch?.match(/ws:\/\/\S+/)?.[0];
}

/** CDP liveness probe: the ws endpoint host must answer /json/version. */
async function probeEndpoint(wsEndpoint: string): Promise<boolean> {
	let host: string;
	try {
		host = new URL(wsEndpoint).host;
	} catch {
		return false;
	}
	const status = await probeCdpStatus(`http://${host}/json/version`, { timeoutMs: PROBE_TIMEOUT_MS });
	return status !== null && status >= 200 && status < 300;
}

/**
 * Ensure the project-shared or global automation Chromium is running and
 * reachable. Concurrent starts adopt the winner's endpoint on the next
 * describe round. Returns null when Chromium or its broker is unavailable;
 * callers must surface the failure, never substitute a temporary profile.
 *
 * Per-open process flags are intentionally absent: a running shared Chromium
 * cannot be relaunched for one tab. `allow_file_access` is rejected before this
 * boundary; invalid-certificate handling remains page-scoped through CDP.
 */
export async function ensureSharedBrowser(opts: {
	projectDir: string;
	headless: boolean;
	globalState?: boolean;
	viewport?: { width: number; height: number };
	signal?: AbortSignal;
}): Promise<SharedBrowserEndpoint | null> {
	const client = opts.globalState
		? await daemonClientForGlobal(GLOBAL_BROWSER_SCOPE)
		: await daemonClientForProject(opts.projectDir);
	const name = sharedBrowserDaemonName(opts.headless);
	const runtimeDir = opts.globalState ? client.projectDir : daemonRuntimeDir(client.projectDir);
	const userDataDir = path.join(runtimeDir, `${name}.profile`);
	const launch = await resolveSharedBrowserLaunchSpec({
		headless: opts.headless,
		userDataDir,
		viewport: opts.viewport,
	});
	if (!launch) return null;
	await fs.mkdir(userDataDir, { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < ENSURE_ATTEMPTS; attempt++) {
		throwIfAborted(opts.signal);
		const existing = await describeQuietly(client, name, "Shared browser", opts.signal);
		if (existing && existing.state !== "exited" && existing.state !== "failed") {
			const settled =
				existing.readyAt !== undefined ? existing : await waitReady(client, name, "Shared browser", opts.signal);
			const wsEndpoint = wsEndpointOf(settled);
			if (wsEndpoint && (await probeEndpoint(wsEndpoint))) {
				return { wsEndpoint, daemonName: name, projectDir: client.projectDir, runtimeDir };
			}
			// Live record but unreachable Chrome (wedged, or readiness never
			// matched): replace it rather than handing out a dead endpoint.
			await stopQuietly(client, name, "Shared browser", opts.signal);
			continue;
		}
		try {
			const started = await client.request(
				{
					op: "start",
					spec: {
						name,
						application: launch.executablePath,
						args: launch.args,
						env: {},
						cwd: client.projectDir,
						pty: false,
						ready: { log: READY_LOG_PATTERN, timeoutMs: READY_TIMEOUT_MS },
						restart: "no",
						persist: false,
						detached: false,
					},
				},
				opts.signal,
			);
			if (started.op !== "start") continue;
			const wsEndpoint = started.readyTimedOut ? undefined : wsEndpointOf(started.daemon);
			if (wsEndpoint && (await probeEndpoint(wsEndpoint))) {
				return { wsEndpoint, daemonName: name, projectDir: client.projectDir, runtimeDir };
			}
			await stopQuietly(client, name, "Shared browser", opts.signal);
		} catch (error) {
			throwIfAborted(opts.signal);
			// Lost a cross-process start race ("already starting/ready"); the next
			// describe round adopts the winner's endpoint.
			logger.debug("Shared browser start contention", {
				name,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return null;
}
