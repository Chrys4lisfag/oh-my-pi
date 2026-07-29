import { describe, expect, it } from "bun:test";
import {
	createCodexProviderStreamError,
	isCodexContentFlagFailure,
	isRetryableCodexFailureEvent,
} from "../../src/providers/openai-codex-responses";

describe("isRetryableCodexFailureEvent", () => {
	it("classifies retryable codes from nested error.code, error.type, then rawEvent.code", () => {
		expect(isRetryableCodexFailureEvent({ error: { code: "server_error" } })).toBe(true);
		expect(isRetryableCodexFailureEvent({ error: { type: "internal_error" } })).toBe(true);
		expect(isRetryableCodexFailureEvent({ code: "model_error" })).toBe(true);
	});

	it("prefers nested error.code over the top-level code (matching the factory)", () => {
		// The error.code chain wins, so a non-retryable nested code with no retryable message
		// is NOT retryable even though the top-level code is retryable.
		expect(isRetryableCodexFailureEvent({ code: "server_error", error: { code: "bad_request" } })).toBe(false);
	});

	it("detects retryable messages when the code is absent or unknown", () => {
		expect(isRetryableCodexFailureEvent({ message: "Please retry your request shortly" })).toBe(true);
		expect(isRetryableCodexFailureEvent({ code: "bad_request", message: "we are overloaded" })).toBe(true);
		expect(isRetryableCodexFailureEvent({ response: { message: "service unavailable" } })).toBe(true);
	});

	it("returns false for non-retryable code and message", () => {
		expect(isRetryableCodexFailureEvent({ code: "bad_request", message: "invalid input" })).toBe(false);
		expect(isRetryableCodexFailureEvent({})).toBe(false);
	});

	it("falls back to response.error when rawEvent.error is not an object", () => {
		expect(isRetryableCodexFailureEvent({ error: "boom", response: { error: { code: "server_error" } } })).toBe(true);
	});

	it("ignores mistyped fields instead of failing the whole parse", () => {
		// A numeric top-level `code` must not poison parsing; the retryable message is still honored.
		expect(isRetryableCodexFailureEvent({ code: 500, message: "internal error while processing" })).toBe(true);
		// Same tolerance nested: a non-string error.code is dropped while a valid error.message survives.
		expect(isRetryableCodexFailureEvent({ error: { code: 123, message: "server error happened" } })).toBe(true);
	});
});

describe("createCodexProviderStreamError", () => {
	it("prefers nested error.code over the top-level code (aligned with isRetryable)", () => {
		expect(createCodexProviderStreamError({ code: "outer_code", error: { code: "inner_code" } }).code).toBe(
			"inner_code",
		);
	});

	it("falls back to nested error.code then error.type", () => {
		expect(createCodexProviderStreamError({ error: { code: "inner_code" } }).code).toBe("inner_code");
		expect(createCodexProviderStreamError({ error: { type: "inner_type" } }).code).toBe("inner_type");
	});

	it("leaves code undefined when nothing supplies one", () => {
		expect(createCodexProviderStreamError({ message: "boom" }).code).toBeUndefined();
	});

	it("marks retryable error events and formats them as error events", () => {
		const err = createCodexProviderStreamError({ type: "error", code: "server_error", message: "kaboom" });
		expect(err.retryable).toBe(true);
		expect(err.code).toBe("server_error");
		expect(err.message).toContain("error event");
		expect(err.message).toContain("kaboom");
	});

	it("formats non-error failures via the response-failure path", () => {
		const err = createCodexProviderStreamError({
			type: "response.failed",
			response: { error: { message: "downstream blew up" } },
		});
		expect(err.retryable).toBe(false);
		expect(err.code).toBeUndefined();
		expect(err.message).toContain("response failed");
		expect(err.message).toContain("downstream blew up");
	});

	it("falls back to response.error when rawEvent.error is not an object", () => {
		const err = createCodexProviderStreamError({
			error: "boom",
			response: { error: { code: "server_error", message: "nested boom" } },
		});
		expect(err.code).toBe("server_error");
		expect(err.retryable).toBe(true);
		expect(err.message).toContain("nested boom");
	});
});
describe("isCodexContentFlagFailure", () => {
	it("matches the visible Codex cybersecurity-flag copy the server ships", () => {
		expect(
			isCodexContentFlagFailure(
				undefined,
				"Codex error event: This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing…",
			),
		).toBe(true);
	});

	it("matches OpenAI content-policy / content-filter wording variants", () => {
		expect(isCodexContentFlagFailure(undefined, "request rejected: content_policy_violation")).toBe(true);
		expect(isCodexContentFlagFailure(undefined, "the response was blocked by our content filter")).toBe(true);
		expect(isCodexContentFlagFailure(undefined, "sensitive content detected")).toBe(true);
	});

	it("matches on the CodexProviderStreamError code path even when the message is generic", () => {
		const flagged = createCodexProviderStreamError({
			type: "response.failed",
			response: { error: { code: "content_policy_violation", message: "no reason" } },
		});
		expect(isCodexContentFlagFailure(flagged, "no reason")).toBe(true);
	});

	it("does NOT match usage-limit, rate-limit, auth, or transport errors", () => {
		expect(isCodexContentFlagFailure(undefined, "The usage limit has been reached (code=usage_limit_reached)")).toBe(
			false,
		);
		expect(isCodexContentFlagFailure(undefined, "429 Too Many Requests")).toBe(false);
		expect(isCodexContentFlagFailure(undefined, "401 Unauthorized")).toBe(false);
		expect(isCodexContentFlagFailure(undefined, "Codex websocket transport error: connection reset")).toBe(false);
	});

	it("returns false when both error and message are empty", () => {
		expect(isCodexContentFlagFailure(undefined, undefined)).toBe(false);
		expect(isCodexContentFlagFailure(undefined, "")).toBe(false);
	});
});
