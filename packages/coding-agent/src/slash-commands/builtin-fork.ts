import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { SlashCommandSpec } from "./types";

/** Fork-specific commands kept separate from the upstream modular registry. */
export const BUILTIN_FORK_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "accounts",
		description: "Manage which logged-in accounts are used for model requests (routing)",
		inlineHint: "[provider]",
		allowArgs: true,
		handleTui: (command, runtime) => {
			const providerId = command.args.trim();
			if (providerId) {
				const matchedProvider = getOAuthProviders().find(provider => provider.id === providerId);
				if (!matchedProvider) {
					runtime.ctx.showWarning(`Unknown OAuth provider: ${providerId}`);
					runtime.ctx.editor.setText("");
					return;
				}
				void runtime.ctx.showAccountsSelector(matchedProvider.id);
				runtime.ctx.editor.setText("");
				return;
			}
			void runtime.ctx.showAccountsSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "profiles",
		aliases: ["profile"],
		description: "Manage model profiles",
		subcommands: [
			{ name: "list", description: "List all profiles" },
			{ name: "add", description: "Save current config as a profile", usage: "<name>" },
			{ name: "switch", description: "Switch to a profile", usage: "<name>" },
			{ name: "delete", description: "Delete a profile", usage: "<name>" },
			{ name: "rename", description: "Rename a profile", usage: "<old> <new>" },
			{ name: "save", description: "Update active profile with current config" },
		],
		allowArgs: true,
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.addToHistory(command.text);
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleProfilesCommand(command.args);
		},
	},
];
