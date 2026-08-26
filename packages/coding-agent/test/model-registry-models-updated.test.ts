/**
 * Contract: `ModelRegistry.onModelsUpdated(listener) => unsubscribe` fires
 * subscribers once per top-level refresh settle (only when a rebuild actually
 * occurred), returns an unsubscribe fn, and isolates a throwing listener from
 * refresh + sibling listeners.
 *
 * Regression for the profiles-advisor sync fix set: `AgentSession` wires
 * `ensureAdvisorsBuilt` to this event so a configured advisor model that
 * loaded late (via `refreshInBackground()` after the session was built) still
 * activates without an explicit rebuild.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("ModelRegistry.onModelsUpdated", () => {
	let sharedDir: TempDir;

	beforeAll(() => {
		sharedDir = TempDir.createSync("@pi-model-registry-models-updated-shared-");
	});

	afterAll(async () => {
		try {
			await sharedDir.remove();
		} catch {}
	});

	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		authStorage = await AuthStorage.create(":memory:");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(() => {
		authStorage.close();
	});

	it("fires a subscribed listener at least once on refresh() settle", async () => {
		let calls = 0;
		modelRegistry.onModelsUpdated(() => {
			calls += 1;
		});

		await modelRegistry.refresh();

		expect(calls).toBeGreaterThanOrEqual(1);
	});

	it("stops firing after the returned unsubscribe fn is called", async () => {
		let calls = 0;
		const unsubscribe = modelRegistry.onModelsUpdated(() => {
			calls += 1;
		});

		await modelRegistry.refresh();
		const afterFirst = calls;
		expect(afterFirst).toBeGreaterThanOrEqual(1);

		unsubscribe();
		await modelRegistry.refresh();

		expect(calls).toBe(afterFirst);
	});

	it("delivers to every subscriber and isolates a throwing listener", async () => {
		let goodCalls = 0;
		let laterCalls = 0;
		modelRegistry.onModelsUpdated(() => {
			goodCalls += 1;
		});
		modelRegistry.onModelsUpdated(() => {
			throw new Error("boom");
		});
		modelRegistry.onModelsUpdated(() => {
			laterCalls += 1;
		});

		// refresh() itself must not surface the listener's throw.
		await expect(modelRegistry.refresh()).resolves.toBeUndefined();

		expect(goodCalls).toBeGreaterThanOrEqual(1);
		expect(laterCalls).toBeGreaterThanOrEqual(1);
	});
});
