# Provider and authentication fixes

This document describes live provider/authentication behavior that differs from
`origin/main` at the audit baseline. Reapply by contract; upstream file names and
request builders change frequently.

## 1. Gemini tool-call normalization

### Named-tool forcing

**Problem.** A bare `"required"` choice lets Gemini compile a constraint grammar
across every declared tool. Large MCP catalogs (observed around 270 tools) can fail
with `400 INVALID_ARGUMENT` / “too many states for serving”.

**Contract.** `buildNamedToolChoice(toolName, model)` returns
`{ type: "tool", name: toolName }` for all three Google APIs:

- `google-generative-ai`
- `google-gemini-cli`
- `google-vertex`

Google transports convert that form to `mode: "ANY"` plus
`allowedFunctionNames: [toolName]`. Do not regress Google to bare `"required"`.
Ollama remains bare `"required"`; Anthropic and OpenAI use their own named forms.

**Implementation.**

- `packages/coding-agent/src/utils/tool-choice.ts`
  - `buildNamedToolChoice`
- Google wire conversion lives in current upstream transport code:
  - `packages/ai/src/providers/google-shared.ts`
  - `packages/ai/src/providers/google-gemini-cli.ts`
- Regression test:
  - `packages/coding-agent/test/build-named-tool-choice.test.ts`

### System-instruction nudge

**Problem.** Gemini/Antigravity sometimes emits namespaced tool names such as
`default_api.foo` or malformed JSON string arguments.

**Contract.** `buildGoogleGenerateContentParams` appends one idempotent instruction
to the final system-prompt part: use the exact declared function name, no namespace,
and JSON-escape string values. Earlier system-prompt parts remain unchanged.

**Implementation.**

- `packages/ai/src/providers/google-shared.ts`
  - `GEMINI_TOOL_CALL_NUDGE`
  - `appendGeminiToolCallNudge`
  - final-part mapping in `buildGoogleGenerateContentParams`

This builder currently covers direct Google Generative AI and Vertex requests. The
fork-only change in `google-gemini-cli.ts` is explanatory commentary, not a separate
normalization implementation.

**Coverage gap.** No direct request-body regression test asserts nudge insertion,
idempotence, or final-part-only behavior.

## 2. Venice Qwen/OpenAI compatibility

Two independent Venice failures must remain fixed.

### Qwen thinking dialect

**Problem.** Venice uses a strict OpenAI-compatible schema with
`additionalProperties: false`. The generic Qwen dialect emits top-level
`enable_thinking`, which Venice rejects with `unrecognized_keys`.

**Contract.** Identify Venice by provider or `api.venice.ai` host and select
`thinkingFormat: "openai"` for Venice-hosted Qwen models. Non-Venice Qwen providers
retain their normal dialects.

**Implementation.**

- `packages/catalog/src/hosts.ts`
  - `KNOWN_HOSTS.venice`
- `packages/catalog/src/compat/openai.ts`
  - `buildOpenAICompat`
  - `isVenice` host classification
  - Qwen branch treats Venice like Fireworks and selects `"openai"`
- Test: `packages/catalog/test/venice-qwen-thinking.test.ts`

Never patch generated `packages/catalog/src/models.json` for this behavior.

### Per-model native tool support

**Problem.** Venice discovery reports
`model_spec.capabilities.supportsFunctionCalling`. Some encrypted/uncensored models
return `false` and reject a native `tools` array.

**Contract.** In Venice discovery, map explicit
`supportsFunctionCalling: false` to `supportsTools: false`. Leave true or missing
values unforced. The agent can then use its prompted/in-band tool dialect.

**Implementation.**

- `packages/catalog/src/provider-models/openai-compat.ts`
  - `veniceModelManagerOptions(...).mapModel`
- Test: `packages/catalog/test/venice-tool-support.test.ts`

Both Venice halves are required. Fixing the thinking field does not fix unsupported
native tools, and vice versa.

## 3. Codex safety-filter failure handling and OAuth attribution

### Current contract

Codex stream failures matching cybersecurity/content-policy wording or known
moderation codes are classifier refusals, not transient provider faults.

1. Provider layer marks the message with
   `stopDetails = { type: "sensitive", explanation }`.
2. Agent layer has a narrow text fallback for providers that omit structured
   refusal details.
3. Refusal turns are skipped from session persistence and removed from active
   context so the blocked text does not poison later requests.
4. The same model is not retried. A configured fallback-chain consult may still run.
5. Before refusal handling, failed OAuth turns receive
   `[oauth <email|accountId|projectId>]` in `errorMessage`, once only, so the user
   can identify the serving account.

This is the authoritative behavior. It contradicts the remembered phrase “cyber
error don't omit in history”: current code intentionally omits the refusal turn from
persisted/active context while preserving a visible, account-tagged failure.

### Implementation

- `packages/ai/src/providers/openai-codex-responses.ts`
  - `CODEX_CONTENT_FLAG_MESSAGE`
  - `CODEX_CONTENT_FLAG_CODES`
  - `isCodexContentFlagFailure`
  - `handleCodexStreamFailure`
- `packages/coding-agent/src/session/agent-session.ts`
  - `AGENT_CLASSIFIER_REFUSAL_MESSAGE`
  - `#isClassifierRefusal`
  - `#annotateAssistantErrorWithAccount`
  - refusal persistence/pruning/retry branches
- Tests:
  - `packages/ai/src/providers/__tests__/openai-codex-error.test.ts`

Keep patterns narrow. Usage-limit, authentication, 429, and transport failures must
not become classifier refusals.

## 4. OpenAI Codex K12 account eligibility

**Problem.** ChatGPT Edu/K12 OAuth accounts report plan type `k12`. Without explicit
classification, paid-model selection treats them as unknown and can route to an
exhausted Plus account instead.

**Contract.** `k12` is a paid plan token.

**Implementation.**

- `packages/ai/src/auth-storage.ts`
  - `OPENAI_CODEX_PAID_PLAN_TOKENS.k12 = true`
- Test:
  - `packages/ai/test/auth-storage-codex-selection.test.ts`
  - healthy K12 account wins over an exhausted Plus account for a paid model

## 5. Retry and capacity policy

### Google `RESOURCE_EXHAUSTED`

**Contract.** Do not include `resource.?exhausted` in the persistent credential
usage-limit pattern. Google commonly uses `RESOURCE_EXHAUSTED` for transient model
capacity; rotating through sibling credentials wastes accounts and triggers long
capacity waits. It must fall through to provider/transient retry handling.

**Implementation.**

- `packages/ai/src/error/rate-limit.ts`
  - `USAGE_LIMIT_PATTERN`
  - comments and decision tree around `isUsageLimitOutcome`

When upstream expands this regex, take the newest upstream pattern **minus**
`resource.?exhausted`.

### Anthropic overload patience

**Contract.** `MAX_RETRY_DELAY_S` is 30, not upstream's shorter cap. Early pre-content
retries remain 0.5, 1, 2, 4, 8, 16 seconds; sustained overloads reach the 30-second
cap. Server `retry-after` still overrides it. The replay-safety guards must remain,
so visible streamed content is never duplicated.

**Implementation.**

- `packages/ai/src/providers/anthropic-client.ts`
  - `MAX_RETRY_DELAY_S = 30`
  - `calculateAnthropicRetryDelayMs`
- Provider retry loop: `packages/ai/src/providers/anthropic.ts`

### Dormant incremental schedule

The fork exports `INCREMENTAL_BACKOFF_MS = [5000, 15000, 50000, 50000]` and
`getIncrementalBackoffMs` from `packages/ai/src/utils/retry-after.ts` through
`packages/ai/src/index.ts`. No current caller uses either symbol. Do not claim this
schedule is active, and do not preserve it at the expense of upstream architecture.
Either wire it with a contract test or remove it in a deliberate cleanup.

## Commit references

- `f26026115` — surviving Gemini, rate-limit, retry helper, and utility ports
- `33c307bd5` — Anthropic overload backoff cap
- `9e94e73df` — K12 paid-plan classification
- `d410d0965` — Codex safety refusal and OAuth account tag
- `32b11c08c` — Venice thinking/tool capability fixes

## Focused verification

```sh
(cd packages/coding-agent && bun test test/build-named-tool-choice.test.ts)
(cd packages/catalog && bun test test/venice-qwen-thinking.test.ts test/venice-tool-support.test.ts)
(cd packages/ai && bun test \
  src/providers/__tests__/openai-codex-error.test.ts \
  test/auth-storage-codex-selection.test.ts \
  test/rate-limit-utils.test.ts \
  test/anthropic-client.test.ts \
  test/anthropic-stream-timeout.test.ts)
```

Run direct `bun test`, not the package `test` script: the latter may select a broad CI
bucket and ignore the requested file list.
