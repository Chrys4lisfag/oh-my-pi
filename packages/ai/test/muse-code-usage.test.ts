import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { museCodeUsageProvider } from "@oh-my-pi/pi-ai/usage/muse-code";

const credential = {
	type: "oauth" as const,
	accessToken: JSON.stringify({ oauthAccessToken: "meta-account-access", apiKey: "LLM|subscription-key" }),
	expiresAt: Date.now() + 60_000,
	email: "stored@example.com",
};

describe("Muse Code subscription usage", () => {
	test("maps rolling and weekly plan quota without leaking the inference key", async () => {
		let authorization = "";
		const fetchImpl: FetchImpl = (_input, init) => {
			authorization = new Headers(init?.headers).get("Authorization") ?? "";
			return Promise.resolve(
				Response.json({
					api_key: "LLM|subscription-key",
					user_email: "Muse@Example.com",
					is_subs_active: true,
					subs_tier_name: "Power Usage",
					subs_usage: {
						window: { used_percent: 42, resets_at: 1_800_000_000, window_duration_mins: 300 },
						weekly: { used_percent: 75, resets_at: "2030-01-08T00:00:00.000Z" },
					},
				}),
			);
		};

		const report = await museCodeUsageProvider.fetchUsage(
			{ provider: "muse-code", credential },
			{ fetch: fetchImpl },
		);

		expect(authorization).toBe("Bearer meta-account-access");
		expect(report?.provider).toBe("muse-code");
		expect(report?.metadata).toMatchObject({ email: "muse@example.com", tier: "Power Usage" });
		expect(report?.raw).not.toHaveProperty("api_key");
		expect(report?.limits).toHaveLength(2);
		expect(report?.limits[0]).toMatchObject({
			id: "300m",
			label: "5 Hours",
			amount: { used: 42, usedFraction: 0.42 },
			window: { durationMs: 18_000_000, resetsAt: 1_800_000_000_000 },
		});
		expect(report?.limits[1]).toMatchObject({
			id: "1w",
			label: "Weekly",
			amount: { used: 75, usedFraction: 0.75 },
			window: { durationMs: 604_800_000, resetsAt: Date.parse("2030-01-08T00:00:00.000Z") },
		});
	});

	test("does not report Meta PAYG credentials as Muse subscription quota", () => {
		expect(
			museCodeUsageProvider.supports?.({
				provider: "meta",
				credential: { type: "api_key", apiKey: "LLM|payg-key" },
			}),
		).toBe(false);
	});

	test("reports inactive subscriptions through credential validation", async () => {
		const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
			usageFetch: Object.assign(() => Promise.resolve(Response.json({ is_subs_active: false }, { status: 200 })), {
				preconnect: fetch.preconnect,
			}),
		});
		try {
			await storage.reload();
			await storage.set("muse-code", [
				{
					type: "oauth",
					access: credential.accessToken,
					refresh: "meta-refresh",
					expires: Date.now() + 3_600_000,
				},
			]);

			const [result] = await storage.checkCredentials();
			expect(result.ok).toBe(false);
			expect(result.reason).toContain("inactive");
		} finally {
			storage.close();
		}
	});
});
