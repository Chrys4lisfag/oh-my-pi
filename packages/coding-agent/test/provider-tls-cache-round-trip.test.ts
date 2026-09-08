/**
 * Provider-level `tls` survives the discovery cache.
 *
 * `tls` is CONFIG, not catalog: a model restored from `models.db` carries
 * whatever its spec held when the row was written. The cold-start cached path
 * rebuilt models from cached specs plus compat and never re-applied provider
 * config, so a `tls` block added after the cache was written (or any row
 * predating the field) produced a bare model — the provider then failed
 * `ERR_TLS_CERT_ALTNAME_INVALID` on every request even though
 * `rejectUnauthorized: false` was configured, and every earlier hop looked
 * correct: the YAML parsed, the provider override carried the flag, and the
 * `toModelSpec`/`buildModel` round-trip preserved it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const PROVIDER = "tls-gateway";
const MODEL_ID = "gw-model";

describe("provider tls survives the discovery cache", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelsYmlPath: string;
	let cacheDbPath: string;

	function writeConfig(withTls: boolean): Promise<number> {
		return Bun.write(
			modelsYmlPath,
			[
				"providers:",
				`  ${PROVIDER}:`,
				'    baseUrl: "https://10.0.0.1/v1"',
				"    api: openai-completions",
				"    auth: none",
				...(withTls ? ["    tls:", "      rejectUnauthorized: false"] : []),
				"    discovery:",
				"      type: openai-models-list",
				"",
			].join("\n"),
		);
	}

	function modelsResponse(): Response {
		return new Response(JSON.stringify({ data: [{ id: MODEL_ID, object: "model" }] }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-tls-cache-");
		modelsYmlPath = path.join(tempDir.path(), "models.yml");
		cacheDbPath = path.join(tempDir.path(), "models.db");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	});

	afterEach(() => {
		authStorage?.close();
		tempDir.removeSync();
	});

	it("re-applies tls to models restored from a cache row written without it", async () => {
		// 1. Discover and cache while the provider has NO tls block: the cached
		//    spec is written without the field, exactly like a row predating it.
		await writeConfig(false);
		const seeding = new ModelRegistry(authStorage, modelsYmlPath, {
			cacheDbPath,
			fetch: (async () => modelsResponse()) as unknown as typeof fetch,
		});
		await seeding.refresh("online");
		expect(seeding.find(PROVIDER, MODEL_ID)?.tls).toBeUndefined();

		// 2. The operator adds the tls opt-in and restarts. Discovery serves the
		//    cached row (no network), which is where the flag used to vanish.
		await writeConfig(true);
		const restarted = new ModelRegistry(authStorage, modelsYmlPath, {
			cacheDbPath,
			fetch: (async () => {
				throw new Error("offline refresh must not hit the network");
			}) as unknown as typeof fetch,
		});
		await restarted.refresh("offline");

		const cached = restarted.find(PROVIDER, MODEL_ID);
		expect(cached).toBeDefined();
		expect(cached?.tls).toEqual({ rejectUnauthorized: false });
		// The whole catalog projection must agree, not just a direct lookup:
		// `getAvailable()` is what the session and RPC `set_model` read.
		const available = restarted.getAvailable().find(m => m.provider === PROVIDER && m.id === MODEL_ID);
		expect(available?.tls).toEqual({ rejectUnauthorized: false });
	});

	it("leaves models alone when the provider configures no tls", async () => {
		await writeConfig(false);
		const registry = new ModelRegistry(authStorage, modelsYmlPath, {
			cacheDbPath,
			fetch: (async () => modelsResponse()) as unknown as typeof fetch,
		});
		await registry.refresh("online");
		expect(registry.find(PROVIDER, MODEL_ID)?.tls).toBeUndefined();
	});

	it("drops tls again when the operator removes the block", async () => {
		await writeConfig(true);
		const seeding = new ModelRegistry(authStorage, modelsYmlPath, {
			cacheDbPath,
			fetch: (async () => modelsResponse()) as unknown as typeof fetch,
		});
		await seeding.refresh("online");
		expect(seeding.find(PROVIDER, MODEL_ID)?.tls).toEqual({ rejectUnauthorized: false });

		// Verification must come back on when the opt-in goes away, even though
		// the cached spec now HAS the field.
		await writeConfig(false);
		const restarted = new ModelRegistry(authStorage, modelsYmlPath, {
			cacheDbPath,
			fetch: (async () => modelsResponse()) as unknown as typeof fetch,
		});
		await restarted.refresh("offline");
		expect(restarted.find(PROVIDER, MODEL_ID)?.tls).toBeUndefined();
	});
});
