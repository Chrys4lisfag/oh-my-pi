/**
 * `transportFetch` is idempotent PER MODEL, not globally.
 *
 * The built fetch closes over the model: its TLS opt-in, the per-provider proxy
 * and the base fetch selection. The idempotence stamp exists so re-entry with
 * the SAME model does not layer transport concerns twice (`streamSimple`
 * re-enters `stream`, and `streamSimpleRequest` re-enters itself on auth
 * retries — three `PI_REQ_DEBUG` dumps for one request). But the stamp used to
 * be a bare boolean, so a fetch built for one model was returned verbatim for
 * another: a session that switched models (`set_model`, role cycling, retry
 * fallback) kept the first model's transport and silently dropped the second's
 * `tls.rejectUnauthorized`.
 */
import { describe, expect, it } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import { transportFetch } from "@oh-my-pi/pi-ai/utils/transport-fetch";

type TlsInit = RequestInit & { tls?: { rejectUnauthorized?: boolean } };

function model(id: string, tls?: { rejectUnauthorized: boolean }): Model<Api> {
	return {
		provider: "gw",
		id,
		api: "openai-completions",
		baseUrl: "https://10.0.0.1/v1",
		...(tls ? { tls } : {}),
	} as Model<Api>;
}

function recorder(): { fetch: typeof fetch; init: () => TlsInit | undefined; calls: () => number } {
	let seen: TlsInit | undefined;
	let calls = 0;
	const impl = (async (_input: string | URL | Request, init?: TlsInit) => {
		calls++;
		seen = init;
		return new Response("{}");
	}) as unknown as typeof fetch;
	return { fetch: impl, init: () => seen, calls: () => calls };
}

const PLAIN = model("plain");
const RELAXED = model("relaxed", { rejectUnauthorized: false });

describe("transportFetch model identity", () => {
	it("applies the model's tls opt-in", async () => {
		const base = recorder();
		await transportFetch(RELAXED, base.fetch)("https://10.0.0.1/v1/chat", {});
		expect(base.init()?.tls?.rejectUnauthorized).toBe(false);
	});

	it("does not apply tls for a model without the opt-in", async () => {
		const base = recorder();
		await transportFetch(PLAIN, base.fetch)("https://10.0.0.1/v1/chat", {});
		expect(base.init()?.tls).toBeUndefined();
	});

	it("reuses the built fetch when re-entered for the same model", () => {
		const base = recorder();
		const first = transportFetch(RELAXED, base.fetch);
		expect(transportFetch(RELAXED, first)).toBe(first);
	});

	it("calls the base fetch exactly once per request after re-entry", async () => {
		const base = recorder();
		const first = transportFetch(RELAXED, base.fetch);
		const reentered = transportFetch(RELAXED, transportFetch(RELAXED, first));
		await reentered("https://10.0.0.1/v1/chat", {});
		expect(base.calls()).toBe(1);
	});

	it("rebuilds for a different model instead of reusing a stale transport", async () => {
		const base = recorder();
		const forPlain = transportFetch(PLAIN, base.fetch);
		await forPlain("https://10.0.0.1/v1/chat", {});
		expect(base.init()?.tls).toBeUndefined();

		// The reported failure: the session switches to a relaxed provider and
		// hands the previously built transport back in.
		const forRelaxed = transportFetch(RELAXED, forPlain);
		expect(forRelaxed).not.toBe(forPlain);
		await forRelaxed("https://10.0.0.1/v1/chat", {});
		expect(base.init()?.tls?.rejectUnauthorized).toBe(false);
	});

	it("rebuilds from the original base, without double-layering", async () => {
		const base = recorder();
		const forPlain = transportFetch(PLAIN, base.fetch);
		const forRelaxed = transportFetch(RELAXED, forPlain);
		await forRelaxed("https://10.0.0.1/v1/chat", {});
		// One request must reach the base once: wrapping the previous transport
		// instead of its base would apply every concern twice.
		expect(base.calls()).toBe(1);
	});

	it("restores strict verification when switching back", async () => {
		const base = recorder();
		const forRelaxed = transportFetch(RELAXED, base.fetch);
		const backToPlain = transportFetch(PLAIN, forRelaxed);
		await backToPlain("https://10.0.0.1/v1/chat", {});
		expect(base.init()?.tls).toBeUndefined();
	});
});
