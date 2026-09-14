import { describe, expect, it, vi } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { assertConfiguredNoLog } from "../src/utils/request-body-policy";
import { transportFetch } from "../src/utils/transport-fetch";

const context: Context = {
	messages: [{ role: "user", content: "ping", timestamp: 0 }],
};

const common: Pick<
	ModelSpec<"openai-completions">,
	"name" | "provider" | "baseUrl" | "reasoning" | "input" | "cost" | "contextWindow" | "maxTokens"
> = {
	name: "No-log proxy model",
	provider: "no-log-proxy",
	baseUrl: "https://proxy.example/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 1_024,
};
const extraBody = { "no-log": true, routing_hint: "preserved" };
const models: Model[] = [
	buildModel({
		...common,
		id: "no-log-chat",
		api: "openai-completions",
		compat: { extraBody },
	} satisfies ModelSpec<"openai-completions">),
	buildModel({
		...common,
		id: "no-log-responses",
		api: "openai-responses",
		compat: { extraBody },
	} satisfies ModelSpec<"openai-responses">),
	buildModel({
		...common,
		id: "no-log-anthropic",
		api: "anthropic-messages",
		compat: { extraBody },
	} satisfies ModelSpec<"anthropic-messages">),
];

function rejectingFetch(captured: Array<Record<string, unknown>>): FetchImpl {
	return Object.assign(
		async (_input: string | URL | Request, init?: RequestInit) => {
			captured.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
			return new Response(JSON.stringify({ error: { message: "captured" } }), {
				status: 400,
				headers: { "content-type": "application/json" },
			});
		},
		{ preconnect: fetch.preconnect },
	);
}

describe("provider no-log request-body contract", () => {
	it.each(models)("injects configured no-log into $api final wire body", async requestModel => {
		const captured: Array<Record<string, unknown>> = [];
		await streamSimple(requestModel, context, {
			apiKey: "test-key",
			fetch: rejectingFetch(captured),
		}).result();

		expect(captured).toHaveLength(1);
		expect(captured[0]).toMatchObject({ "no-log": true, routing_hint: "preserved" });
	});

	it.each(models)("blocks $api before fetch when a payload interceptor removes no-log", async requestModel => {
		const fetchMock = vi.fn(rejectingFetch([]));
		const result = await streamSimple(requestModel, context, {
			apiKey: "test-key",
			fetch: fetchMock as FetchImpl,
			onPayload: payload => {
				const replaced = { ...(payload as Record<string, unknown>) };
				delete replaced["no-log"];
				return replaced;
			},
		}).result();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain('required body field "no-log": true');
	});

	it("rejects an explicitly weakened configured value", () => {
		expect(() => assertConfiguredNoLog({ "no-log": false }, { "no-log": false })).toThrow(
			'compat.extraBody["no-log"] must be true',
		);
	});

	it("checks CCH-style byte bodies without altering bytes sent to fetch", async () => {
		const baseFetch = vi.fn(async () => new Response("ok")) as unknown as FetchImpl;
		const guardedFetch = transportFetch(models[2], baseFetch);
		const bytes = new TextEncoder().encode('{"no-log":true}');
		const padded = new Uint8Array(bytes.length + 4);
		padded.set(bytes, 2);
		const bodies = [bytes, bytes.buffer, new DataView(padded.buffer, 2, bytes.length)];
		for (const body of bodies) {
			await guardedFetch("https://proxy.example/request", { method: "POST", body });
		}
		expect(baseFetch).toHaveBeenCalledTimes(3);
		for (const body of [new TextEncoder().encode("{}"), new TextEncoder().encode('{"no-log":false}')]) {
			await expect(guardedFetch("https://proxy.example/request", { method: "POST", body })).rejects.toThrow(
				'required body field "no-log": true',
			);
		}
		expect(baseFetch).toHaveBeenCalledTimes(3);
	});

	it("blocks unsupported/future transports centrally when their serializer drops no-log", async () => {
		const baseFetch = vi.fn(async () => new Response("ok")) as unknown as FetchImpl;
		const unknownDialectModel = {
			...models[0],
			api: "google-generative-ai",
			// Simulate a resolver that does not expose extraBody for this API:
			// compatConfig remains the authored, transport-independent contract.
			compat: {},
			compatConfig: { extraBody: { "no-log": true } },
		} as unknown as Model<"google-generative-ai">;
		const guardedFetch = transportFetch(unknownDialectModel, baseFetch);

		await expect(
			guardedFetch("https://proxy.example/request", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ prompt: "unsafe" }),
			}),
		).rejects.toThrow('required body field "no-log": true');
		expect(baseFetch).not.toHaveBeenCalled();

		await guardedFetch("https://proxy.example/request", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "safe", "no-log": true }),
		});
		expect(baseFetch).toHaveBeenCalledTimes(1);

		const request = new Request("https://proxy.example/request", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "safe request", "no-log": true }),
		});
		await guardedFetch(request);
		expect(baseFetch).toHaveBeenCalledTimes(2);
		expect(await request.clone().json()).toMatchObject({ "no-log": true });

		await expect(
			guardedFetch(
				new Request("https://proxy.example/request", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ prompt: "unsafe request" }),
				}),
			),
		).rejects.toThrow('required body field "no-log": true');
		expect(baseFetch).toHaveBeenCalledTimes(2);
	});
});
