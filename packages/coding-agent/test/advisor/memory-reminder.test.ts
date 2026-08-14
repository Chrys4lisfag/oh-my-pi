import { describe, expect, it } from "bun:test";
import {
	beginAdvisorMemoryTurn,
	createAdvisorMemoryReminderState,
	endAdvisorMemoryTurn,
	formatAdvisorMemoryReminder,
	isMemoryRelatedAdvisor,
	recordAdvisorMemoryReminderInjection,
	recordAdvisorMemoryToolAttempt,
	resetAdvisorMemoryReminderState,
} from "../../src/advisor/memory-reminder";

const instructions = `You are a Memory Adviser. For every substantive task, you MUST call recall.
Use reflect for cross-session patterns and learn only verified lessons.`;

describe("advisor memory reminder", () => {
	it("classifies only memory-related advisors with recall access", () => {
		expect(isMemoryRelatedAdvisor(instructions, new Set(["recall", "reflect"]))).toBe(true);
		expect(isMemoryRelatedAdvisor(instructions, new Set(["read", "grep"]))).toBe(false);
		expect(isMemoryRelatedAdvisor("Review code and report defects.", new Set(["recall"]))).toBe(false);
		expect(
			isMemoryRelatedAdvisor(
				"Do not call recall. Learn project conventions and reflect on code quality.",
				new Set(["recall", "reflect", "learn"]),
			),
		).toBe(false);
		expect(isMemoryRelatedAdvisor("Review recall metrics and learn conventions.", new Set(["recall"]))).toBe(false);
	});

	it("reminds on every configured interval without retrieval", () => {
		const state = createAdvisorMemoryReminderState(instructions, new Set(["recall"]), 3)!;
		expect(beginAdvisorMemoryTurn(state)).toBe(false);
		endAdvisorMemoryTurn(state);
		expect(beginAdvisorMemoryTurn(state)).toBe(false);
		endAdvisorMemoryTurn(state);
		expect(beginAdvisorMemoryTurn(state)).toBe(true);
		endAdvisorMemoryTurn(state);
		expect(beginAdvisorMemoryTurn(state)).toBe(false);
		endAdvisorMemoryTurn(state);
		expect(beginAdvisorMemoryTurn(state)).toBe(false);
		endAdvisorMemoryTurn(state);
		expect(beginAdvisorMemoryTurn(state)).toBe(true);
	});

	it("resets the streak after recall or reflect", () => {
		const state = createAdvisorMemoryReminderState(instructions, new Set(["recall", "reflect"]), 3)!;
		beginAdvisorMemoryTurn(state);
		endAdvisorMemoryTurn(state);
		beginAdvisorMemoryTurn(state);
		recordAdvisorMemoryToolAttempt(state, "recall");
		endAdvisorMemoryTurn(state);
		expect(state.contextReadsWithoutRetrieval).toBe(0);
		expect(beginAdvisorMemoryTurn(state)).toBe(false);
		endAdvisorMemoryTurn(state);
		beginAdvisorMemoryTurn(state);
		recordAdvisorMemoryToolAttempt(state, "reflect");
		endAdvisorMemoryTurn(state);
		expect(state.contextReadsWithoutRetrieval).toBe(0);
	});

	it("does not let learn substitute for retrieval", () => {
		const state = createAdvisorMemoryReminderState(instructions, new Set(["recall", "learn"]), 2)!;
		beginAdvisorMemoryTurn(state);
		recordAdvisorMemoryToolAttempt(state, "learn");
		endAdvisorMemoryTurn(state);
		expect(beginAdvisorMemoryTurn(state)).toBe(true);
	});

	it("counts actual injections and resets them only at a conversation boundary", () => {
		const state = createAdvisorMemoryReminderState(instructions, new Set(["recall"]), 3)!;
		expect(state.reminderInjections).toBe(0);
		recordAdvisorMemoryReminderInjection(state);
		recordAdvisorMemoryReminderInjection(state);
		state.contextReadsWithoutRetrieval = 2;
		state.artifactUri = "artifact://42";

		resetAdvisorMemoryReminderState(state, { preserveInjectionCount: true });
		expect(state.reminderInjections).toBe(2);
		expect(state.contextReadsWithoutRetrieval).toBe(0);
		expect(state.artifactUri).toBeUndefined();

		resetAdvisorMemoryReminderState(state);
		expect(state.reminderInjections).toBe(0);
	});

	it("points the advisor at its instruction artifact", () => {
		const reminder = formatAdvisorMemoryReminder("artifact://42");
		expect(reminder).toContain("MUST use `recall`");
		expect(reminder).toContain("artifact://42");
		expect(reminder).toContain("do not need to send advice");
	});
});
