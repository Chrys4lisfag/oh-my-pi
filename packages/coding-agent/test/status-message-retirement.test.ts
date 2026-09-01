/**
 * Status lines (`showStatus`) coalesce back-to-back messages by mutating the
 * previously presented `Text` block. That in-place update is only visible while
 * the block is still live viewport content: once its rows retire into native
 * terminal scrollback the terminal owns those bytes, and `setText` renders
 * nowhere — the status silently disappears.
 *
 * Regression: pressing the profile-cycle keybind right after a tall status block
 * (e.g. `/profiles list`) showed no message at all in terminals whose viewport
 * had already forced that block to retire.
 */
import { beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { type Component, Text } from "@oh-my-pi/pi-tui";

const WIDTH = 80;

function buildContext(): InteractiveModeContext {
	const chatContainer = new TranscriptContainer();
	const ctx = {
		chatContainer,
		lastStatusSpacer: undefined,
		lastStatusText: undefined,
		ui: { requestRender: vi.fn() },
		present(content: Component | readonly Component[]): void {
			for (const item of Array.isArray(content) ? content : [content]) chatContainer.addChild(item);
		},
	} as unknown as InteractiveModeContext;
	return ctx;
}

/** Force the currently eligible prefix into native history, as viewport pressure does. */
function retireEverything(chatContainer: TranscriptContainer): void {
	for (;;) {
		const batch = chatContainer.peekFinalizedBatch(WIDTH, 0);
		if (!batch) return;
		chatContainer.acknowledgeFinalizedBatch(batch.id);
	}
}

function liveText(chatContainer: TranscriptContainer): string {
	return Bun.stripANSI(chatContainer.renderViewport(WIDTH, 100, { tick: 0, now: 0 }).join("\n"));
}

beforeAll(async () => {
	await initTheme(false);
});

describe("showStatus retirement safety", () => {
	it("coalesces consecutive statuses while the block is still live", () => {
		const ctx = buildContext();
		const helpers = new UiHelpers(ctx);

		helpers.showStatus("Profile: edu");
		helpers.showStatus("Profile: cyber");

		expect(ctx.chatContainer.children.length).toBe(2);
		expect(liveText(ctx.chatContainer)).toContain("Profile: cyber");
		expect(liveText(ctx.chatContainer)).not.toContain("Profile: edu");
	});

	it("presents a fresh status line once the previous one retired into history", () => {
		const ctx = buildContext();
		const helpers = new UiHelpers(ctx);

		helpers.showStatus("Model Profiles:\n  edu\n  cyber");
		const retiredText = ctx.chatContainer.children[1];
		retireEverything(ctx.chatContainer);
		expect(ctx.chatContainer.isBlockLive(retiredText as Component)).toBe(false);

		helpers.showStatus("Profile: cyber");

		// A new spacer + text pair is appended instead of mutating retired bytes.
		expect(ctx.chatContainer.children.length).toBe(4);
		expect(ctx.chatContainer.children[3]).not.toBe(retiredText);
		expect(liveText(ctx.chatContainer)).toContain("Profile: cyber");
	});

	it("keeps every switch visible across repeated cycles that each retire", () => {
		const ctx = buildContext();
		const helpers = new UiHelpers(ctx);
		const seen: string[] = [];

		for (const name of ["edu", "cyber", "nightly"]) {
			helpers.showStatus(`Profile: ${name}`);
			seen.push(liveText(ctx.chatContainer));
			retireEverything(ctx.chatContainer);
		}

		expect(seen[0]).toContain("Profile: edu");
		expect(seen[1]).toContain("Profile: cyber");
		expect(seen[2]).toContain("Profile: nightly");
	});

	it("does not reuse a status block that is no longer the transcript tail", () => {
		const ctx = buildContext();
		const helpers = new UiHelpers(ctx);

		helpers.showStatus("Profile: edu");
		ctx.chatContainer.addChild(new Text("unrelated transcript block", 1, 0));

		helpers.showStatus("Profile: cyber");

		expect(ctx.chatContainer.children.length).toBe(5);
		expect(liveText(ctx.chatContainer)).toContain("Profile: edu");
		expect(liveText(ctx.chatContainer)).toContain("Profile: cyber");
	});
});

describe("TranscriptContainer.isBlockLive", () => {
	it("reports false for unknown, retired, and partially emitted blocks", () => {
		const ctx = buildContext();
		const helpers = new UiHelpers(ctx);
		helpers.showStatus("Profile: edu");
		const [spacer, text] = ctx.chatContainer.children as [Component, Component];

		expect(ctx.chatContainer.isBlockLive(text)).toBe(true);
		expect(ctx.chatContainer.isBlockLive(spacer)).toBe(true);

		retireEverything(ctx.chatContainer);

		expect(ctx.chatContainer.isBlockLive(text)).toBe(false);
		expect(ctx.chatContainer.isBlockLive(spacer)).toBe(false);
		expect(ctx.chatContainer.isBlockLive(new TranscriptContainer())).toBe(false);
	});

	it("stays consistent with canRemoveBlock", () => {
		const ctx = buildContext();
		const helpers = new UiHelpers(ctx);
		helpers.showStatus("Profile: edu");
		const text = ctx.chatContainer.children[1] as Component;

		expect(ctx.chatContainer.canRemoveBlock(text)).toBe(ctx.chatContainer.isBlockLive(text));
		retireEverything(ctx.chatContainer);
		expect(ctx.chatContainer.canRemoveBlock(text)).toBe(ctx.chatContainer.isBlockLive(text));
	});
});

describe("profile cycle status over a real transcript", () => {
	it("renders the switch message even when the previous status already retired", async () => {
		resetSettingsForTest();
		try {
			await Settings.init({ inMemory: true });
			const settings = Settings.isolated();
			settings.set("profiles.items", {
				edu: { modelRoles: { default: "provider/edu-model" }, defaultThinkingLevel: "low" },
				cyber: { modelRoles: { default: "provider/cyber-model" }, defaultThinkingLevel: "high" },
			});
			settings.set("profiles.active", "edu");

			const ctx = buildContext();
			const helpers = new UiHelpers(ctx);
			const mutable = ctx as unknown as Record<string, unknown>;
			mutable.settings = settings;
			mutable.statusLine = { invalidate: vi.fn() };
			mutable.updateEditorBorderColor = vi.fn();
			mutable.showError = vi.fn();
			mutable.showStatus = (message: string, options?: { dim?: boolean }) => helpers.showStatus(message, options);
			mutable.session = {
				bindSessionProfile: vi.fn(async () => true),
				resolveRoleModel: vi.fn(() => ({ id: "cyber-model", provider: "provider" })),
			};

			// A tall `/profiles list` status that has already retired to history.
			helpers.showStatus("Model Profiles:\n  edu\n  cyber");
			retireEverything(ctx.chatContainer);

			await new InputController(ctx).cycleModelProfile();

			expect(settings.activeProfileName()).toBe("cyber");
			expect(liveText(ctx.chatContainer)).toContain("Profile: cyber");
			expect(mutable.showError).not.toHaveBeenCalled();
		} finally {
			resetSettingsForTest();
		}
	});
});
