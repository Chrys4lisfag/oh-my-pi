/**
 * Per-provider TLS relaxation (`models.yml` → `providers.<id>.tls`).
 *
 * A gateway serving an expired or self-signed certificate fails every request
 * with `certificate has expired` — including the `/models` discovery probe,
 * which is where it first surfaces. The only pre-existing escape was
 * `NODE_TLS_REJECT_UNAUTHORIZED=0`, which disables verification process-wide
 * (first-party providers and OAuth flows included).
 *
 * Contract: `tls: { rejectUnauthorized: false }` relaxes verification for that
 * one provider — on the discovery probe and on the model's inference requests
 * — and leaves every other provider fully verified.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir, wrapFetchForInsecureTls } from "@oh-my-pi/pi-utils";

type TlsInit = RequestInit & { tls?: { rejectUnauthorized?: boolean; ca?: string | string[] } };

describe("per-provider insecure TLS", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelsYmlPath: string;
	let cacheDbPath: string;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-provider-tls-");
		modelsYmlPath = path.join(tempDir.path(), "models.yml");
		cacheDbPath = path.join(tempDir.path(), "models.db");
		await Bun.write(
			modelsYmlPath,
			[
				"providers:",
				"  expired-gateway:",
				'    baseUrl: "https://expired.example/v1"',
				"    api: openai-completions",
				"    auth: none",
				"    tls:",
				"      rejectUnauthorized: false",
				"    discovery:",
				"      type: openai-models-list",
				"  strict-gateway:",
				'    baseUrl: "https://strict.example/v1"',
				"    api: openai-completions",
				"    auth: none",
				"    discovery:",
				"      type: openai-models-list",
				"",
			].join("\n"),
		);
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	});

	afterEach(() => {
		authStorage?.close();
		tempDir.removeSync();
	});

	function harness(): { registry: ModelRegistry; seen: Map<string, boolean | undefined> } {
		const seen = new Map<string, boolean | undefined>();
		const registry = new ModelRegistry(authStorage, modelsYmlPath, {
			cacheDbPath,
			fetch: (async (input: string | URL | Request, init?: TlsInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				seen.set(new URL(url).hostname, init?.tls?.rejectUnauthorized);
				return new Response(JSON.stringify({ data: [{ id: "gw-model", object: "model" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}) as unknown as typeof fetch,
		});
		return { registry, seen };
	}

	it("relaxes the discovery probe for the opted-in provider only", async () => {
		const { registry, seen } = harness();
		await registry.refresh("online");

		// The opted-in gateway's /models probe carries the relaxation...
		expect(seen.get("expired.example")).toBe(false);
		// ...and the provider that did not ask for it keeps full verification
		// (no `tls` override at all, so Bun's default trust store applies).
		expect(seen.has("strict.example")).toBe(true);
		expect(seen.get("strict.example")).toBeUndefined();
	});

	it("carries the flag onto the provider's discovered models for inference", async () => {
		const { registry } = harness();
		await registry.refresh("online");

		const relaxed = registry.getAll().find(model => model.provider === "expired-gateway");
		expect(relaxed?.tls).toEqual({ rejectUnauthorized: false });

		const strict = registry.getAll().find(model => model.provider === "strict-gateway");
		expect(strict).toBeDefined();
		expect(strict?.tls).toBeUndefined();
	});
});

describe("wrapFetchForInsecureTls", () => {
	it("injects rejectUnauthorized: false and preserves the caller's own tls fields", async () => {
		let init: TlsInit | undefined;
		const base = (async (_input: string | URL | Request, received?: TlsInit) => {
			init = received;
			return new Response("{}");
		}) as unknown as typeof fetch;

		await wrapFetchForInsecureTls(base)("https://expired.example/v1/models", {
			method: "POST",
			// A caller-supplied CA bundle (the NODE_EXTRA_CA_CERTS shim) survives.
			tls: { ca: "-----BEGIN CERTIFICATE-----" },
		} as TlsInit);

		expect(init?.method).toBe("POST");
		expect(init?.tls?.rejectUnauthorized).toBe(false);
		expect(init?.tls?.ca).toBe("-----BEGIN CERTIFICATE-----");
	});

	it("lets an explicit caller rejectUnauthorized win", async () => {
		let init: TlsInit | undefined;
		const base = (async (_input: string | URL | Request, received?: TlsInit) => {
			init = received;
			return new Response("{}");
		}) as unknown as typeof fetch;

		await wrapFetchForInsecureTls(base)("https://strict.example/v1/models", {
			tls: { rejectUnauthorized: true },
		} as TlsInit);

		expect(init?.tls?.rejectUnauthorized).toBe(true);
	});
});
