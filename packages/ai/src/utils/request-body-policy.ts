import { isRecord } from "@oh-my-pi/pi-utils";

const NO_LOG_FIELD = "no-log";

/**
 * Enforce the opt-in zero-log request-body contract after every payload hook.
 *
 * `no-log` is LiteLLM proxy metadata, not an HTTP header. Providers that put it
 * in `compat.extraBody` require the final serialized JSON body to retain the
 * literal boolean `true`; an interceptor may add fields but must not remove or
 * weaken this one. Throwing here guarantees `fetch` has not started.
 */
export function assertConfiguredNoLog(
	payload: unknown,
	extraBody: Readonly<Record<string, unknown>> | undefined,
): void {
	if (!extraBody || !Object.hasOwn(extraBody, NO_LOG_FIELD)) return;
	if (extraBody[NO_LOG_FIELD] !== true) {
		throw new Error('Invalid no-log contract: compat.extraBody["no-log"] must be true');
	}
	if (!isRecord(payload) || payload[NO_LOG_FIELD] !== true) {
		throw new Error('Blocked provider request: required body field "no-log": true is missing after payload hooks');
	}
}

/** Final serialized-fetch guard for every API, including future transports. */
export function assertConfiguredNoLogBody(
	body: RequestInit["body"],
	extraBody: Readonly<Record<string, unknown>> | undefined,
): void {
	if (!extraBody || !Object.hasOwn(extraBody, NO_LOG_FIELD)) return;
	if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
		body = new TextDecoder("utf-8", { fatal: true }).decode(body);
	}
	if (typeof body !== "string") {
		assertConfiguredNoLog(undefined, extraBody);
		return;
	}
	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		throw new Error('Blocked provider request: required body field "no-log": true cannot be verified in JSON');
	}
	assertConfiguredNoLog(payload, extraBody);
}

/**
 * Verify the actual fetch body without consuming a caller-owned Request.
 * `init.body` wins exactly as fetch semantics do; otherwise clone Request input.
 */
export async function assertConfiguredNoLogRequest(
	input: string | URL | Request,
	init: RequestInit | undefined,
	extraBody: Readonly<Record<string, unknown>> | undefined,
): Promise<void> {
	if (!extraBody || !Object.hasOwn(extraBody, NO_LOG_FIELD)) return;
	if (init?.body !== undefined && init.body !== null) {
		assertConfiguredNoLogBody(init.body, extraBody);
		return;
	}
	if (input instanceof Request) {
		assertConfiguredNoLogBody(await input.clone().text(), extraBody);
		return;
	}
	assertConfiguredNoLogBody(undefined, extraBody);
}

/** Authored/resolved extraBody without assuming a particular API compat type. */
export function getConfiguredExtraBody(model: {
	compatConfig?: unknown;
	compat?: unknown;
}): Readonly<Record<string, unknown>> | undefined {
	for (const candidate of [model.compatConfig, model.compat]) {
		if (!isRecord(candidate) || !isRecord(candidate.extraBody)) continue;
		return candidate.extraBody;
	}
	return undefined;
}
