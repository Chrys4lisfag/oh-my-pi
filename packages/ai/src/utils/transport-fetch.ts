import { resolveExtraCa, withExtraCaInit, withInsecureTlsInit } from "@oh-my-pi/pi-utils";
import { coworkFetch } from "../providers/cowork-fetch";
import { withInferenceUserAgent } from "../providers/inference-headers";
import type { Api, FetchImpl, Model } from "../types";
import { getProxyForProvider, withProxyInit } from "./proxy";
import { createFetchRequestDebugSession, isRequestDebugEnabled } from "./request-debug";
import { assertConfiguredNoLogRequest, getConfiguredExtraBody } from "./request-body-policy";

/**
 * Stamped on a fetch already built by {@link transportFetch}: the identity of
 * the model it was built FOR, plus the base fetch it wraps so it can be rebuilt
 * for a different model without double-layering.
 */
const TRANSPORT_FETCH = Symbol("omp.transportFetch");
const TRANSPORT_FETCH_BASE = Symbol("omp.transportFetch.base");

type TransportFetch = FetchImpl & {
	[TRANSPORT_FETCH]?: string;
	[TRANSPORT_FETCH_BASE]?: FetchImpl;
};

/**
 * What makes a built transport reusable. Everything the closure captures must
 * appear here: the provider (proxy lookup, cowork base fetch), the api (base
 * fetch selection) and the model's TLS opt-in. A fetch built for one model is
 * NOT valid for another — reusing it silently dropped the second model's
 * `tls.rejectUnauthorized`, so a session that started on an ordinary model and
 * switched (`set_model`, role cycling, retry fallback) to a bare-IP gateway
 * kept failing `ERR_TLS_CERT_ALTNAME_INVALID` with the opt-in configured.
 */
function transportIdentity(model: Model<Api>): string {
	const extraBody = getConfiguredExtraBody(model);
	const noLogIdentity = Object.hasOwn(extraBody ?? {}, "no-log") ? String(extraBody?.["no-log"]) : "";
	return [
		model.provider,
		model.id,
		model.api,
		model.tls?.rejectUnauthorized === false ? "insecure-tls" : "",
		noLogIdentity,
	].join("\u0000");
}

/**
 * The one fetch every inference request goes through. Per call it applies, in
 * order: the inference User-Agent default, `NODE_EXTRA_CA_CERTS`, the model's
 * opt-in TLS relaxation (`models.yml` → `tls`), the per-provider proxy, and
 * `PI_REQ_DEBUG` request/response recording — then calls `fetchImpl` (or the
 * model's default fetch) exactly once. Providers never layer transport concerns
 * themselves.
 *
 * The TLS relaxation is applied after the CA bundle so `rejectUnauthorized`
 * lands beside `tls.ca` rather than replacing it: a private gateway can carry
 * a custom CA and still skip hostname/expiry verification.
 *
 * Idempotent PER MODEL: the built fetch is stamped with its model identity and
 * returned as-is when re-entered for the SAME model. `streamSimple` re-enters
 * `stream`, and `streamSimpleRequest` re-enters itself on auth retries, so
 * without that each entry point would add another layer (three PI_REQ_DEBUG
 * dumps for one request).
 *
 * Handed a transport built for a DIFFERENT model, it rebuilds from the original
 * base fetch rather than returning the stale one (which would apply the wrong
 * model's TLS/proxy/User-Agent) or wrapping it again (which would double-layer
 * those concerns).
 */
export function transportFetch(model: Model<Api>, fetchImpl: FetchImpl | undefined): FetchImpl {
	const given = fetchImpl as TransportFetch | undefined;
	const identity = transportIdentity(model);
	const givenIdentity = given?.[TRANSPORT_FETCH];
	if (givenIdentity !== undefined) {
		if (givenIdentity === identity) return given as FetchImpl;
		// Built for another model: start again from what it wraps.
		fetchImpl = given?.[TRANSPORT_FETCH_BASE];
	}
	const unwrapped = fetchImpl as TransportFetch | undefined;
	const base =
		unwrapped ??
		(model.provider === "anthropic" && model.api === "anthropic-messages" ? coworkFetch : globalThis.fetch);
	const proxyUrl = getProxyForProvider(model.provider);
	const configuredExtraBody = getConfiguredExtraBody(model);

	const fetch: TransportFetch = async (input, init) => {
		await assertConfiguredNoLogRequest(input, init, configuredExtraBody);
		init = withInferenceUserAgent(input, init);
		const extraCa = resolveExtraCa();
		if (extraCa) init = withExtraCaInit(init, extraCa);
		if (model.tls?.rejectUnauthorized === false) init = withInsecureTlsInit(init);
		if (proxyUrl) init = withProxyInit(input, init, proxyUrl);
		if (!isRequestDebugEnabled()) return base(input, init);
		const session = await createFetchRequestDebugSession(input, init);
		return session.wrapResponse(await base(input, init));
	};
	if (base.preconnect) fetch.preconnect = base.preconnect;
	fetch[TRANSPORT_FETCH] = identity;
	// Keep the unwrapped base so a later model can rebuild without layering.
	if (unwrapped !== undefined) fetch[TRANSPORT_FETCH_BASE] = unwrapped;
	return fetch;
}

/** Options-bag form of {@link transportFetch}; returns `options` untouched when its fetch is already built. */
export function withTransportFetch<T extends { fetch?: FetchImpl }>(model: Model<Api>, options: T): T {
	const fetch = transportFetch(model, options.fetch);
	return fetch === options.fetch ? options : { ...options, fetch };
}
