import { describe, expect, it } from "bun:test";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { convertMessageToLlm } from "../src/compaction/messages";

function result(details: unknown): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-a",
		toolName: "eval",
		content: [{ type: "text", text: "503 transport failure: secret-diagnostic" }],
		isError: true,
		timestamp: 1,
		details,
	};
}

describe("unexecuted provider-error projection", () => {
	it("sanitizes persisted synthetic diagnostics without changing stored execution state", () => {
		const original = result({
			__synthetic: true,
			source: "assistant_stop_error",
			executed: false,
			upstreamError: "503 transport failure: secret-diagnostic",
		});
		const stored = JSON.stringify(original);
		const projected = convertMessageToLlm(original);
		expect(projected).toMatchObject({ role: "toolResult", toolCallId: "call-a", toolName: "eval", isError: false });
		expect(JSON.stringify(projected)).not.toContain("secret-diagnostic");
		expect(JSON.stringify(projected)).not.toContain("503");
		expect(JSON.stringify(original)).toBe(stored);
	});

	it.each([
		undefined,
		{ __synthetic: true, source: "assistant_stop_error", executed: true },
		{ __synthetic: true, source: "assistant_stop_error" },
		{ __synthetic: true, source: "assistant_stop_aborted", executed: false },
		{ __synthetic: true, source: "assistant_stop_length", executed: false },
		{ __synthetic: true, source: "assistant_stop_skipped", executed: false },
	])("does not rewrite actual failures or non-provider interruption state %#", details => {
		const original = result(details);
		const projected = convertMessageToLlm(original);
		expect(projected).toMatchObject({ content: original.content, isError: true });
	});
});
