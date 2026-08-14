const MEMORY_RETRIEVAL_TOOLS = new Set(["recall", "reflect"]);

export const ADVISOR_MEMORY_REMINDER_INTERVAL = 8;

export interface AdvisorMemoryReminderState {
	readonly instructions: string;
	readonly interval: number;
	contextReadsWithoutRetrieval: number;
	retrievalUsedThisTurn: boolean;
	reminderInjections: number;
	artifactUri?: string;
}

/**
 * Classify only advisors whose own custom instructions clearly require memory
 * retrieval and that can actually call recall. Shared advisor instructions do
 * not opt every advisor into this behavior.
 */
export function isMemoryRelatedAdvisor(
	instructions: string | undefined,
	availableToolNames: ReadonlySet<string>,
): boolean {
	if (!instructions?.trim() || !availableToolNames.has("recall")) return false;
	const normalized = instructions.toLowerCase();
	const identifiesMemoryRole = /\bmemory\s+advis(?:or|er)\b|\bmemory[- ]tools?\b/.test(normalized);
	const prohibitsRecall =
		/\b(?:do\s+not|don't|never|must\s+not|should\s+not|avoid)\b[^.!?\n]{0,80}\b(?:call|use|invoke|run)?\s*`?recall`?\b/.test(
			normalized,
		);
	if (prohibitsRecall) return false;
	const requiresRecall =
		/\b(?:must|should|always|use|call|invoke|run)\b[^.!?\n]{0,80}\brecall\b|\brecall\b[^.!?\n]{0,80}\b(?:every|before|proactively|required|must|should)\b/.test(
			normalized,
		);
	const mentionsMemoryWorkflow = /\breflect\b|\blearn\b|\blong[- ]term memory\b/.test(normalized);
	return requiresRecall && (identifiesMemoryRole || mentionsMemoryWorkflow);
}

export function createAdvisorMemoryReminderState(
	instructions: string | undefined,
	availableToolNames: ReadonlySet<string>,
	interval = ADVISOR_MEMORY_REMINDER_INTERVAL,
	reminderInjections = 0,
): AdvisorMemoryReminderState | undefined {
	if (!isMemoryRelatedAdvisor(instructions, availableToolNames)) return undefined;
	return {
		instructions: instructions!.trim(),
		interval: Math.max(1, Math.trunc(interval)),
		contextReadsWithoutRetrieval: 0,
		retrievalUsedThisTurn: false,
		reminderInjections: Math.max(0, Math.trunc(reminderInjections)),
	};
}

/** Begin one advisor context read. Returns true every N consecutive reads. */
export function beginAdvisorMemoryTurn(state: AdvisorMemoryReminderState): boolean {
	state.retrievalUsedThisTurn = false;
	return (state.contextReadsWithoutRetrieval + 1) % state.interval === 0;
}

/** A recall/reflect attempt counts even when its backend fails. */
export function recordAdvisorMemoryToolAttempt(state: AdvisorMemoryReminderState, toolName: string): void {
	if (MEMORY_RETRIEVAL_TOOLS.has(toolName)) state.retrievalUsedThisTurn = true;
}

export function endAdvisorMemoryTurn(state: AdvisorMemoryReminderState): void {
	state.contextReadsWithoutRetrieval = state.retrievalUsedThisTurn ? 0 : state.contextReadsWithoutRetrieval + 1;
	state.retrievalUsedThisTurn = false;
}

/** Record one reminder that was actually injected into an advisor prompt. */
export function recordAdvisorMemoryReminderInjection(state: AdvisorMemoryReminderState): void {
	state.reminderInjections++;
}

export function resetAdvisorMemoryReminderState(
	state: AdvisorMemoryReminderState,
	options: { preserveInjectionCount?: boolean } = {},
): void {
	state.contextReadsWithoutRetrieval = 0;
	state.retrievalUsedThisTurn = false;
	if (!options.preserveInjectionCount) state.reminderInjections = 0;
	state.artifactUri = undefined;
}

export function formatAdvisorMemoryReminder(artifactUri: string): string {
	return `<advisor-memory-reminder>
You are a memory adviser, but low memory retrieval-tool usage was detected. You MUST use \`recall\` near the beginning of every substantive problem or task the primary agent faces. Use \`reflect\` when several memories or a cross-session pattern need synthesis.

You do not need to send advice when retrieval provides nothing useful. Memory-tool activity and advice are separate: retrieve proactively, advise only when the result materially helps.

Your configured advisor instructions are preserved at ${artifactUri}. Read that artifact now if compaction or a long session caused you to forget them.
</advisor-memory-reminder>`;
}
