/**
 * Regression: edit `models.yml`, open `/models` — the new provider is missing;
 * close the menu and open it again — now it is there.
 *
 * The registry only re-read `models.yml` as part of `refresh()`, which is async
 * and gated behind full discovery, while the hub paints synchronously from the
 * snapshot it already has. The first open therefore showed the config as it was
 * at startup; by the second open the async refresh had landed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelHubComponent } from "@oh-my-pi/pi-coding-agent/modes/components/model-hub";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

function providerBlock(id: string, host: string): string {
	return [
		`  ${id}:`,
		`    baseUrl: "https://${host}/v1"`,
		"    api: openai-completions",
		"    auth: none",
		"    discovery:",
		"      type: openai-models-list",
		"",
	].join("\n");
}

describe("models.yml edits without restarting omp", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelsYml: string;
	let registry: ModelRegistry;

	beforeEach(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Failed to load dark theme");
		setThemeInstance(theme);
		tempDir = TempDir.createSync("@pi-models-yml-live-");
		modelsYml = path.join(tempDir.path(), "models.yml");
		await Bun.write(modelsYml, `providers:\n${providerBlock("first-vuln", "first.example")}`);
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		registry = new ModelRegistry(authStorage, modelsYml, {
			cacheDbPath: path.join(tempDir.path(), "models.db"),
			// Never let discovery reach the network in this test.
			fetch: (async () =>
				new Response(JSON.stringify({ data: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				})) as unknown as typeof fetch,
		});
	});

	afterEach(() => {
		authStorage?.close();
		tempDir.removeSync();
	});

	async function addSecondProvider(): Promise<void> {
		const current = await Bun.file(modelsYml).text();
		await Bun.write(modelsYml, current + providerBlock("second-vuln", "second.example"));
	}

	it("reloadConfigFromDisk picks up a new provider without any network work", async () => {
		expect(registry.getDiscoverableProviders()).toContain("first-vuln");
		expect(registry.getDiscoverableProviders()).not.toContain("second-vuln");

		await addSecondProvider();
		expect(registry.reloadConfigFromDisk()).toBe(true);
		expect(registry.getDiscoverableProviders()).toContain("second-vuln");

		// Idempotent: an unchanged file is a no-op, so opening the hub repeatedly
		// does not re-parse and re-emit on every keystroke-driven rebuild.
		expect(registry.reloadConfigFromDisk()).toBe(false);
	});

	it("shows a provider added while omp was running on the FIRST hub open", async () => {
		await addSecondProvider();

		const ui = { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI;
		const hub = new ModelHubComponent(ui, Settings.isolated({}), registry, [], {
			onAssign: () => {},
			onUnassign: () => {},
			onLoginRequest: () => {},
			onCancel: () => {},
		});
		try {
			// First paint only — no awaiting the async discovery that used to be
			// the only thing that re-read the file.
			const rendered = hub
				.render(220)
				.map(line => stripVTControlCharacters(line))
				.join("\n");
			expect(rendered).toContain("second-vuln");
		} finally {
			hub.dispose();
		}
	});
});
