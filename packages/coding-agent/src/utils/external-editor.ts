/**
 * Utilities for launching an external text editor ($VISUAL / $EDITOR).
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $env, Snowflake } from "@oh-my-pi/pi-utils";

/** Returns the user's preferred editor command, or undefined if not configured. */
export function getEditorCommand(): string | undefined {
	return $env.VISUAL || $env.EDITOR || undefined;
}

export interface OpenInEditorOptions {
	/** File extension for the temp file (default: ".md"). */
	extension?: string;
	/** Custom stdio configuration (default: all "inherit"). */
	stdio?: [number | "inherit", number | "inherit", number | "inherit"];
	/** Keep the file's trailing newline instead of trimming it from the returned text. */
	trimTrailingNewline?: boolean;
}

/**
 * Opens `content` in the user's external editor and returns the edited text.
 * Returns `null` if the editor exits with a non-zero code.
 *
 * The caller is responsible for stopping/starting the TUI around this call.
 */
export async function openInEditor(
	editorCmd: string,
	content: string,
	options?: OpenInEditorOptions,
): Promise<string | null> {
	const ext = options?.extension ?? ".md";
	const tmpFile = path.join(os.tmpdir(), `omp-editor-${Snowflake.next()}${ext}`);

	try {
		await Bun.write(tmpFile, content);

		const [editor, ...editorArgs] = editorCmd.split(" ");
		const stdio = options?.stdio ?? ["inherit", "inherit", "inherit"];

		// GUI editors (VSCode, Cursor, Sublime, Zed, Atom) launchers exit immediately,
		// delegating the actual editor window to a background daemon. Without the wait
		// flag, our `child.once("exit")` fires before the user has typed anything; we
		// read back the unmodified temp file and lose the edit. Auto-inject `--wait`
		// (`-w` for Sublime) if the user hasn't supplied one.
		const lowerCmd = editorCmd.toLowerCase();
		const isGuiEditor = ["code", "code-insiders", "cursor", "subl", "zed", "atom"].some(gui =>
			lowerCmd.includes(gui),
		);
		const hasWaitFlag = lowerCmd.includes("--wait") || / -w(\s|$)/.test(lowerCmd);
		if (isGuiEditor && !hasWaitFlag) {
			editorArgs.unshift(lowerCmd.includes("subl") ? "-w" : "--wait");
		}

		const child = spawn(editor, [...editorArgs, tmpFile], { stdio, shell: process.platform === "win32" });
		const { promise, reject, resolve } = Promise.withResolvers<number>();
		child.once("exit", (code, signal) => resolve(code ?? (signal ? -1 : 0)));
		child.once("error", error => reject(error));
		const exitCode = await promise;

		if (exitCode === 0) {
			const text = await Bun.file(tmpFile).text();
			if (options?.trimTrailingNewline === false) {
				return text;
			}
			return text.replace(/\n$/, "");
		}
		return null;
	} finally {
		try {
			await fs.rm(tmpFile, { force: true });
		} catch {
			// Ignore cleanup errors
		}
	}
}
