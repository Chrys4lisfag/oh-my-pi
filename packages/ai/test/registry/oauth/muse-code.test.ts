import { afterEach, describe, expect, test, vi } from "bun:test";
import { getProviderDefinition } from "../../../src/registry/registry";
import { attachMuseCodeApiKey, parseMuseCodeCredential } from "../../../src/registry/oauth/muse-code";
import type { FetchImpl } from "../../../src/types";

const DEVICE_URL = "https://auth.meta.com/oidc/device/authorization/";
const TOKEN_URL = "https://auth.meta.com/oidc/device/token/";
const KEY_URL = "https://api.meta.ai/muse-code/key";
const CLIENT_ID = "1031625952748946";

const DEVICE_AUTHORIZATION = {
	device_code: "device-code",
	user_code: "ABCD-EFGH",
	verification_uri: "https://auth.meta.com/device",
	verification_uri_complete: "https://auth.meta.com/device?user_code=ABCD-EFGH",
	expires_in: 600,
	interval: 0.001,
};

const ACCOUNT_TOKEN = {
	access_token: "meta-account-access",
	refresh_token: "meta-refresh",
	expires_in: 3600,
};

const SUBSCRIPTION_KEY = {
	api_key: "LLM|subscription-key",
	user_email: "Muse@Example.com",
	user_id: "meta-account-1",
	is_subs_active: true,
};

interface RecordedRequest {
	url: string;
	init: RequestInit | undefined;
}

interface JsonResponse {
	body: unknown;
	status?: number;
}

interface MuseLoginFetchOptions {
	device?: JsonResponse;
	tokens?: readonly JsonResponse[];
	key?: JsonResponse;
}

function createMuseLoginFetch(options: MuseLoginFetchOptions = {}): {
	fetch: FetchImpl;
	requests: RecordedRequest[];
} {
	const requests: RecordedRequest[] = [];
	let tokenIndex = 0;
	const fetchImpl = Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
			requests.push({ url, init });
			if (url === DEVICE_URL) {
				const response = options.device ?? { body: DEVICE_AUTHORIZATION };
				return Response.json(response.body, { status: response.status ?? 200 });
			}
			if (url === TOKEN_URL) {
				const response = options.tokens?.[tokenIndex++] ?? { body: ACCOUNT_TOKEN };
				return Response.json(response.body, { status: response.status ?? 200 });
			}
			if (url === KEY_URL) {
				const response = options.key ?? { body: SUBSCRIPTION_KEY };
				return Response.json(response.body, { status: response.status ?? 200 });
			}
			throw new Error(`unexpected URL: ${url}`);
		},
		{ preconnect: fetch.preconnect },
	);
	return { fetch: fetchImpl, requests };
}

function requestAt(requests: readonly RecordedRequest[], index: number): RecordedRequest {
	const request = requests[index];
	if (!request) throw new Error(`expected request ${index}, got ${requests.length}`);
	return request;
}

function formBody(request: RecordedRequest): URLSearchParams {
	const body = request.init?.body;
	if (typeof body !== "string") throw new Error("expected form-encoded request body");
	return new URLSearchParams(body);
}

function jsonBody(request: RecordedRequest): unknown {
	const body = request.init?.body;
	if (typeof body !== "string") throw new Error("expected JSON request body");
	return JSON.parse(body) as unknown;
}

function headerValue(request: RecordedRequest, name: string): string | undefined {
	return new Headers(request.init?.headers).get(name) ?? undefined;
}

async function loginMuse(fetchImpl: FetchImpl, onAuth: (url: string, instructions: string) => void = () => {}) {
	const provider = getProviderDefinition("muse-code");
	if (!provider?.login) throw new Error("Muse Code login is not registered");
	const credentials = await provider.login({
		fetch: fetchImpl,
		onAuth: info => onAuth(info.url, info.instructions ?? ""),
	});
	if (typeof credentials === "string") throw new Error("expected OAuth credentials");
	return credentials;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Muse Code OAuth", () => {
	test("uses Meta's verified device and key-mint wire contract", async () => {
		const { fetch: fetchImpl, requests } = createMuseLoginFetch();
		const authEvents: Array<{ url: string; instructions: string }> = [];
		const credentials = await loginMuse(fetchImpl, (url, instructions) => authEvents.push({ url, instructions }));

		expect(authEvents).toEqual([
			{
				url: "https://auth.meta.com/device?user_code=ABCD-EFGH",
				instructions: "Enter code: ABCD-EFGH",
			},
		]);
		expect(requests.map(request => request.url)).toEqual([DEVICE_URL, TOKEN_URL, KEY_URL]);
		for (const request of requests.slice(0, 2)) {
			expect(request.init?.method).toBe("POST");
			expect(headerValue(request, "x-api-version")).toBe("1.0.0");
			expect(headerValue(request, "user-agent")).toBeUndefined();
		}
		expect(formBody(requestAt(requests, 0)).get("client_id")).toBe(CLIENT_ID);
		const poll = formBody(requestAt(requests, 1));
		expect(poll.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
		expect(poll.get("client_id")).toBe(CLIENT_ID);
		expect(poll.get("device_code")).toBe("device-code");
		const mint = requestAt(requests, 2);
		expect(headerValue(mint, "Authorization")).toBe("Bearer meta-account-access");
		expect(headerValue(mint, "x-api-version")).toBe("1.0.0");
		expect(jsonBody(mint)).toEqual({ onboard: true });
		expect(credentials).toMatchObject({
			refresh: "meta-refresh",
			accountId: "meta-account-1",
			email: "muse@example.com",
		});
		expect(parseMuseCodeCredential(credentials.access)).toEqual({
			oauthAccessToken: "meta-account-access",
			apiKey: "LLM|subscription-key",
		});
	});

	test("falls back to verification_uri when verification_uri_complete is absent", async () => {
		const { fetch: fetchImpl } = createMuseLoginFetch({
			device: { body: { ...DEVICE_AUTHORIZATION, verification_uri_complete: undefined } },
		});
		let authUrl = "";
		await loginMuse(fetchImpl, url => {
			authUrl = url;
		});
		expect(authUrl).toBe("https://auth.meta.com/device");
	});

	test("continues through pending and slow-down responses", async () => {
		vi.spyOn(Bun, "sleep").mockResolvedValue(undefined);
		const { fetch: fetchImpl, requests } = createMuseLoginFetch({
			tokens: [
				{ body: { error: "authorization_pending" }, status: 400 },
				{ body: { error: "slow_down" }, status: 400 },
				{ body: ACCOUNT_TOKEN },
			],
		});
		const credentials = await loginMuse(fetchImpl);
		expect(requests.filter(request => request.url === TOKEN_URL)).toHaveLength(3);
		expect(parseMuseCodeCredential(credentials.access).apiKey).toBe("LLM|subscription-key");
	});

	test.each([
		["denied", "access_denied", "muse-code device authorization was denied"],
		["expired", "expired_token", "muse-code device code expired; restart the login"],
	])("surfaces a terminal %s device response", async (_case, error, message) => {
		const { fetch: fetchImpl, requests } = createMuseLoginFetch({
			tokens: [{ body: { error }, status: 400 }],
		});
		await expect(loginMuse(fetchImpl)).rejects.toThrow(message);
		expect(requests.map(request => request.url)).toEqual([DEVICE_URL, TOKEN_URL]);
	});

	test("versions refresh requests and performs a non-onboarding key lookup", async () => {
		const { fetch: fetchImpl, requests } = createMuseLoginFetch();
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchImpl as typeof fetch);
		const provider = getProviderDefinition("muse-code");
		if (!provider?.refreshToken) throw new Error("Muse Code refresh is not registered");
		const refreshed = await provider.refreshToken({
			access: JSON.stringify({ oauthAccessToken: "old-account-access", apiKey: "LLM|old-key" }),
			refresh: "meta-refresh",
			expires: 0,
			accountId: "meta-account-1",
			email: "muse@example.com",
		});

		expect(requests.map(request => request.url)).toEqual([TOKEN_URL, KEY_URL]);
		const token = requestAt(requests, 0);
		expect(headerValue(token, "x-api-version")).toBe("1.0.0");
		const refresh = formBody(token);
		expect(refresh.get("grant_type")).toBe("refresh_token");
		expect(refresh.get("refresh_token")).toBe("meta-refresh");
		const key = requestAt(requests, 1);
		expect(headerValue(key, "Authorization")).toBe("Bearer meta-account-access");
		expect(jsonBody(key)).toEqual({});
		expect(parseMuseCodeCredential(refreshed.access).apiKey).toBe("LLM|subscription-key");
	});

	test("retains the minted key when refresh succeeds but the key endpoint is transiently unavailable", async () => {
		const storedAccess = JSON.stringify({ oauthAccessToken: "old-account-access", apiKey: "LLM|existing-key" });
		const refreshed = await attachMuseCodeApiKey(
			{ access: "new-account-access", refresh: "rotated-refresh", expires: Date.now() + 3_600_000 },
			{
				provider: "muse-code",
				phase: "refresh",
				raw: {},
				fetch: Object.assign(() => Promise.resolve(Response.json({ error: "temporary" }, { status: 503 })), {
					preconnect: fetch.preconnect,
				}),
				stored: {
					access: storedAccess,
					refresh: "old-refresh",
					expires: 0,
					accountId: "meta-account-1",
					email: "muse@example.com",
				},
			},
		);

		expect(parseMuseCodeCredential(refreshed.access)).toEqual({
			oauthAccessToken: "new-account-access",
			apiKey: "LLM|existing-key",
		});
		expect(refreshed).toMatchObject({ accountId: "meta-account-1", email: "muse@example.com" });
	});

	test("classifies a subscription payment action as an entitlement failure", async () => {
		await expect(
			attachMuseCodeApiKey(
				{ access: "meta-account-access", refresh: "meta-refresh", expires: Date.now() + 3_600_000 },
				{
					provider: "muse-code",
					phase: "login",
					raw: {},
					fetch: Object.assign(
						() =>
							Promise.resolve(
								Response.json({
									require_payment: true,
									require_payment_action_url: "https://www.meta.ai/subscribe",
								}),
							),
						{ preconnect: fetch.preconnect },
					),
				},
			),
		).rejects.toMatchObject({
			kind: "entitlement",
			provider: "muse-code",
			message: expect.stringContaining("https://www.meta.ai/subscribe"),
		});
	});

	test("rejects an inactive subscription instead of exposing a Model API credential", async () => {
		await expect(
			attachMuseCodeApiKey(
				{ access: "meta-account-access", refresh: "meta-refresh", expires: Date.now() + 3_600_000 },
				{
					provider: "muse-code",
					phase: "login",
					raw: {},
					fetch: Object.assign(() => Promise.resolve(Response.json({ is_subs_active: false }, { status: 200 })), {
						preconnect: fetch.preconnect,
					}),
				},
			),
		).rejects.toMatchObject({ provider: "muse-code", status: 403 });
	});
});
