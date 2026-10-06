import { Container, matchesKey, ScrollView, Spacer, TruncatedText } from "../index";
import { theme } from "../theme/theme";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import type { LogoutAccount } from "./logout-account-selector";
import { DynamicBorder } from "../chrome/dynamic-border";

const ACCOUNT_SELECTOR_MAX_VISIBLE = 10;

/**
 * Account routing and priority manager for `/accounts <provider>`.
 * Disabled accounts stay logged in; Auto retains automatic account selection.
 */
export class AccountManagerSelectorComponent extends Container {
	#listContainer: Container;
	#accounts: LogoutAccount[];
	#selectedIndex = 0;
	#statusMessage: string | undefined;
	#onToggleCallback: (account: LogoutAccount, nextDisabled: boolean) => void | Promise<void>;
	#onPriorityCallback: (account: LogoutAccount, priority: number | undefined) => void | Promise<void>;
	#onCloseCallback: () => void;
	#onChangeCallback: () => void;
	#busy = false;

	constructor(
		providerName: string,
		accounts: LogoutAccount[],
		onToggle: (account: LogoutAccount, nextDisabled: boolean) => void | Promise<void>,
		onPriority: (account: LogoutAccount, priority: number | undefined) => void | Promise<void>,
		onClose: () => void,
		onChange: () => void,
	) {
		super();
		this.#accounts = accounts;
		this.#onToggleCallback = onToggle;
		this.#onPriorityCallback = onPriority;
		this.#onChangeCallback = onChange;
		this.#onCloseCallback = onClose;
		const activeIndex = accounts.findIndex(account => account.active);
		this.#selectedIndex = activeIndex >= 0 ? activeIndex : 0;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new TruncatedText(theme.bold(`Manage ${providerName} accounts — routing:`)));
		this.addChild(new Spacer(1));
		this.#listContainer = new Container();
		this.addChild(this.#listContainer);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.#updateList();
	}

	#updateList(): void {
		this.#listContainer.clear();

		const total = this.#accounts.length;
		const maxVisible = ACCOUNT_SELECTOR_MAX_VISIBLE;
		const startIndex =
			total <= maxVisible
				? 0
				: Math.max(0, Math.min(this.#selectedIndex - Math.floor(maxVisible / 2), total - maxVisible));
		const endIndex = Math.min(startIndex + maxVisible, total);

		const rows: string[] = [];
		for (let i = startIndex; i < endIndex; i++) {
			const account = this.#accounts[i];
			if (!account) continue;
			const badge = account.routingDisabled
				? theme.fg("warning", "⊘ routing off")
				: theme.fg("accent", "● routing on");
			const activeTag = account.active ? theme.fg("muted", " (active)") : "";
			const priority = theme.fg(
				"muted",
				` · priority ${account.type === "api_key" ? "N/A" : (account.priority ?? "Auto")}`,
			);
			const detail = account.detail ? theme.fg("dim", `  ${account.detail}`) : "";
			if (i === this.#selectedIndex) {
				rows.push(
					`${theme.fg("accent", `${theme.nav.cursor} ${account.label}`)}${activeTag}  ${badge}${priority}${detail}`,
				);
			} else {
				rows.push(`  ${account.label}${activeTag}  ${badge}${priority}${detail}`);
			}
		}

		if (rows.length > 0) {
			const sv = new ScrollView(rows, {
				height: rows.length,
				scrollbar: "auto",
				totalRows: total,
				theme: { track: text => theme.fg("muted", text), thumb: text => theme.fg("accent", text) },
			});
			sv.setScrollOffset(startIndex);
			this.#listContainer.addChild(sv);
		}

		if (total === 0) {
			this.#listContainer.addChild(
				new TruncatedText(theme.fg("muted", "  No stored accounts for this provider"), 0, 0),
			);
		}

		this.#listContainer.addChild(
			new TruncatedText(
				theme.fg("muted", "  ↑/↓ select · ↵/Space routing · +/- priority · a Auto · Esc done"),
				0,
				0,
			),
		);

		if (this.#statusMessage) {
			this.#listContainer.addChild(new Spacer(1));
			this.#listContainer.addChild(new TruncatedText(theme.fg("muted", `  ${this.#statusMessage}`), 0, 0));
		}
	}

	async #mutateSelected(change: "routing" | "increase" | "decrease" | "auto"): Promise<void> {
		const account = this.#accounts[this.#selectedIndex];
		if (!account) return;
		this.#busy = true;
		try {
			if (change === "routing") {
				const nextDisabled = !account.routingDisabled;
				await this.#onToggleCallback(account, nextDisabled);
				account.routingDisabled = nextDisabled;
				this.#statusMessage = `${account.label}: routing ${nextDisabled ? "off" : "on"}`;
			} else {
				if (account.type !== "oauth") throw new Error("Priority is available only for OAuth accounts");
				let priority: number | undefined;
				if (change === "increase") priority = Math.max(1, Math.floor(account.priority ?? 0) + 1);
				else if (change === "decrease" && account.priority !== undefined && account.priority > 1) {
					priority = Math.max(1, Math.ceil(account.priority) - 1);
				}
				if (priority !== undefined && !Number.isSafeInteger(priority)) throw new Error("Priority is too large");
				await this.#onPriorityCallback(account, priority);
				account.priority = priority;
				this.#statusMessage = `${account.label}: priority ${priority ?? "Auto"}`;
			}
		} catch (error) {
			this.#statusMessage = `Could not update ${account.label}: ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			this.#busy = false;
			this.#updateList();
			this.#onChangeCallback();
		}
	}

	async handleInput(keyData: string): Promise<void> {
		if (this.#busy) return;
		if (matchesSelectCancel(keyData)) {
			this.#onCloseCallback();
			return;
		}

		if (matchesSelectUp(keyData)) {
			if (this.#accounts.length > 0) {
				this.#selectedIndex = this.#selectedIndex === 0 ? this.#accounts.length - 1 : this.#selectedIndex - 1;
			}
			this.#statusMessage = undefined;
			this.#updateList();
		} else if (matchesSelectDown(keyData)) {
			if (this.#accounts.length > 0) {
				this.#selectedIndex = this.#selectedIndex === this.#accounts.length - 1 ? 0 : this.#selectedIndex + 1;
			}
			this.#statusMessage = undefined;
			this.#updateList();
		} else if (matchesKey(keyData, "pageUp")) {
			if (this.#accounts.length > 0) {
				this.#selectedIndex = Math.max(0, this.#selectedIndex - ACCOUNT_SELECTOR_MAX_VISIBLE);
			}
			this.#statusMessage = undefined;
			this.#updateList();
		} else if (matchesKey(keyData, "pageDown")) {
			if (this.#accounts.length > 0) {
				this.#selectedIndex = Math.min(
					this.#accounts.length - 1,
					this.#selectedIndex + ACCOUNT_SELECTOR_MAX_VISIBLE,
				);
			}
			this.#statusMessage = undefined;
			this.#updateList();
		} else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n" || keyData === " ") {
			await this.#mutateSelected("routing");
		} else if (keyData === "+" || keyData === "=") {
			await this.#mutateSelected("increase");
		} else if (keyData === "-") {
			await this.#mutateSelected("decrease");
		} else if (keyData === "a" || keyData === "A") {
			await this.#mutateSelected("auto");
		}
	}
}
