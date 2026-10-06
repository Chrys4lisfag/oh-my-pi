import { beforeAll, describe, expect, it } from "bun:test";
import { AccountManagerSelectorComponent } from "@oh-my-pi/pi-tui/overlays/account-manager-selector";
import type { LogoutAccount } from "@oh-my-pi/pi-tui/overlays/logout-account-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(() => initTheme());

const account = (credentialId: number, active = false): LogoutAccount => ({
	credentialId,
	provider: "anthropic",
	label: `Account ${credentialId}`,
	detail: "",
	type: "oauth",
	active,
});
const render = (component: AccountManagerSelectorComponent) =>
	component
		.render(160)
		.map(line => Bun.stripANSI(line))
		.join("\n");

describe("account manager priority interactions", () => {
	it("edits the selected account, returns to Auto, and keeps Enter as the routing toggle", async () => {
		const accounts = [account(1), account(2, true)];
		const priorities: [number, number | undefined][] = [];
		const routing: [number, boolean][] = [];
		let closed = false;
		const component = new AccountManagerSelectorComponent(
			"Anthropic",
			accounts,
			(row, disabled) => {
				routing.push([row.credentialId, disabled]);
			},
			(row, priority) => {
				priorities.push([row.credentialId, priority]);
			},
			() => {
				closed = true;
			},
			() => {},
		);
		await component.handleInput("+");
		await component.handleInput("=");
		expect(render(component)).toContain("priority 2");
		await component.handleInput("-");
		await component.handleInput("a");
		await component.handleInput("\r");
		expect(routing).toEqual([[2, true]]);
		expect(render(component)).toContain("routing off");
		await component.handleInput("\x1b[A");
		await component.handleInput("+");
		await component.handleInput("-");
		expect(priorities).toEqual([
			[2, 1],
			[2, 2],
			[2, 1],
			[2, undefined],
			[1, 1],
			[1, undefined],
		]);
		expect(accounts.map(row => row.priority)).toEqual([undefined, undefined]);
		await component.handleInput("\x1b");
		expect(closed).toBe(true);
	});

	it("does not show an uncommitted priority and ignores repeated edits while saving", async () => {
		const row = { ...account(1), priority: 4 };
		const { promise: save, reject: rejectSave } = Promise.withResolvers<void>();
		const component = new AccountManagerSelectorComponent(
			"Anthropic",
			[row],
			() => {},
			() => save,
			() => {},
			() => {},
		);
		const pending = component.handleInput("+");
		await component.handleInput("a");
		expect(row.priority).toBe(4);
		expect(render(component)).toContain("priority 4");
		rejectSave(new Error("Disk full"));
		await pending;
		expect(row.priority).toBe(4);
		expect(render(component)).toContain("Disk full");
	});

	it("preserves routing state when a routing change throws", async () => {
		const row = account(1);
		const component = new AccountManagerSelectorComponent(
			"Anthropic",
			[row],
			() => {
				throw new Error("Read only");
			},
			() => {},
			() => {},
			() => {},
		);
		await component.handleInput(" ");
		expect(row.routingDisabled).toBeUndefined();
		expect(render(component)).toContain("routing on");
		expect(render(component)).toContain("Read only");
	});

	it("does not offer API keys a misleading account priority", async () => {
		const row = { ...account(1), type: "api_key" as const };
		const component = new AccountManagerSelectorComponent(
			"Anthropic",
			[row],
			() => {},
			() => {
				throw new Error("unexpected priority mutation");
			},
			() => {},
			() => {},
		);
		await component.handleInput("+");
		expect(render(component)).toContain("priority N/A");
		expect(render(component)).toContain("only for OAuth accounts");
	});
});
