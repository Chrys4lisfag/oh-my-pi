import { Container, matchesKey, ScrollView, Spacer, TruncatedText } from "@oh-my-pi/pi-tui";
import { theme } from "../../modes/theme/theme";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../../modes/utils/keybinding-matchers";
import type { LogoutAccount } from "../../slash-commands/helpers/logout";
import { DynamicBorder } from "./dynamic-border";

const ACCOUNT_SELECTOR_MAX_VISIBLE = 10;

/**
 * Account manager for `/accounts <provider>`: toggle whether each stored
 * credential is used for request ROUTING. A disabled account is skipped for
 * model requests but stays logged in and keeps refreshing / reporting usage
 * (deletion lives in `/logout`). The picker stays open across toggles so the
 * user can flip several accounts in one pass; Esc closes it.
 */
export class AccountManagerSelectorComponent extends Container {
	#listContainer: Container;
	#accounts: LogoutAccount[];
	#selectedIndex = 0;
	#statusMessage: string | undefined;
	#onToggleCallback: (account: LogoutAccount, nextDisabled: boolean) => void;
	#onCloseCallback: () => void;

	constructor(
		providerName: string,
		accounts: LogoutAccount[],
		onToggle: (account: LogoutAccount, nextDisabled: boolean) => void,
		onClose: () => void,
	) {
		super();
		this.#accounts = accounts;
		this.#onToggleCallback = onToggle;
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
			const detail = account.detail ? theme.fg("dim", `  ${account.detail}`) : "";
			if (i === this.#selectedIndex) {
				rows.push(`${theme.fg("accent", `${theme.nav.cursor} ${account.label}`)}${activeTag}  ${badge}${detail}`);
			} else {
				rows.push(`  ${account.label}${activeTag}  ${badge}${detail}`);
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
			new TruncatedText(theme.fg("muted", "  ↑/↓ select · ↵/Space toggle routing · Esc done"), 0, 0),
		);

		if (this.#statusMessage) {
			this.#listContainer.addChild(new Spacer(1));
			this.#listContainer.addChild(new TruncatedText(theme.fg("muted", `  ${this.#statusMessage}`), 0, 0));
		}
	}

	#toggleSelected(): void {
		const account = this.#accounts[this.#selectedIndex];
		if (!account) return;
		const nextDisabled = !account.routingDisabled;
		account.routingDisabled = nextDisabled;
		this.#statusMessage = `${account.label}: routing ${nextDisabled ? "off" : "on"}`;
		this.#onToggleCallback(account, nextDisabled);
		this.#updateList();
	}

	handleInput(keyData: string): void {
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
			this.#toggleSelected();
		}
	}
}
