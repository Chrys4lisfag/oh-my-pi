# Memory and runtime customizations

## 1. Hindsight reflect timeout

### Contract

Hindsight synthesis is slower than recall/retain. `reflect` alone gets a configurable
client-side timeout:

- settings key: `hindsight.reflectTimeoutMs`
- default: `60_000`
- environment override: `HINDSIGHT_REFLECT_TIMEOUT_MS`
- all other Hindsight requests retain the fixed 30-second default
- timeout errors report the actual configured seconds

Implementation flow:

1. `packages/coding-agent/src/config/settings-schema.ts` declares the setting and
   Memory/Hindsight UI metadata.
2. `packages/coding-agent/src/hindsight/config.ts` adds
   `HindsightConfig.reflectTimeoutMs` and resolves environment over settings.
3. `packages/coding-agent/src/tools/memory-reflect.ts` passes the value to the API.
4. `packages/coding-agent/src/hindsight/client.ts` adds optional `timeoutMs` to
   `ReflectOptions` and internal request options, then uses it in
   `withTimeoutSignal`.

Do not globally raise `HINDSIGHT_REQUEST_TIMEOUT_MS`; that changes recall, retain,
bank, and health requests too.

Known limit: current integer parsing/settings validation does not enforce a positive
value. Zero or negative environment/config values may produce immediate or invalid
timeout behavior. Tighten only with explicit validation and tests.

Coverage gap: existing `memory-tools.test.ts` and Hindsight fixtures include the new
field but do not assert setting/env resolution, AbortSignal timing, or error text.

## 2. Memory tool visibility under xdev

Memory tools declare discoverable load mode, but the fork keeps direct memory read
paths prominent.

**Contract.** While `tools.xdev` is active:

- `recall`: top-level
- `reflect`: top-level
- `retain`: discoverable and eligible for `xd://` mounting

Implementation:

- `packages/coding-agent/src/tools/xdev.ts`
  - `XDEV_KEEP_TOP_LEVEL` contains `recall: true` and `reflect: true`
  - preserve upstream pins such as `todo`, `ask`, `grep`, and `web_search`
- `packages/coding-agent/src/tools/index.ts`
  - factory registry/backend gating and normal memory tool auto-inclusion
- `packages/coding-agent/src/tools/memory-recall.ts`
- `packages/coding-agent/src/tools/memory-reflect.ts`

The pin is name-based and takes precedence over discoverable `loadMode` in
`isMountableUnderXdev`. Explicit/restricted tool lists can bypass normal auto-add and
mount behavior; the pin does not force a disabled or excluded tool into existence.
Mnemopi `reflect` is local recall/synthesis behavior and does not use the Hindsight
HTTP timeout.

During xdev conflicts, union fork memory pins with new upstream top-level tools. Do
not take one whole object and silently drop the other side.

Coverage gap: current tests prove memory factories and general xdev behavior but do
not directly assert that recall/reflect stay top-level and off the mounted registry.

## 3. Windows/Bun EPIPE crash suppression

**Problem.** Writing to a child process or IPC pipe after the peer exits can surface
as an asynchronous unhandled rejection. Bun may expose a normal error code or only
put `EPIPE` in the message. Synchronous transport try/catch cannot always catch it.

**Contract.** Treat only EPIPE as benign at the process-level unhandled-rejection
boundary; log debug information and return instead of crashing. Preserve upstream's
more specific IPC/cleanup guards alongside this broad fork guard.

Implementation:

- `packages/utils/src/fs-error.ts`
  - `isEpipe(err)` accepts structured `code === "EPIPE"` or an Error message
    containing the standalone token
- `packages/utils/src/postmortem.ts`
  - imports `isEpipe`
  - closed `if (isEpipe(err)) { logger.debug(...); return; }` block in the
    `unhandledRejection` handler

Do not broaden this to all stream or filesystem errors. Real programming failures
must still reach normal fatal postmortem handling.

Test:

- `packages/utils/test/postmortem-epipe.test.ts`

## 4. GUI external editor wait behavior

**Problem.** GUI editor launchers often hand work to an existing process and exit
immediately. OMP then reads the unchanged temporary file before the user edits it.

**Contract.** `openInEditor` auto-injects a wait flag when the command appears to be
one of:

- `code`
- `code-insiders`
- `cursor`
- `subl`
- `zed`
- `atom`

Use `-w` for Sublime and `--wait` for the others. Do not duplicate a user-supplied
`--wait` or `-w`. Windows continues spawning editor commands with `shell: true`.

Implementation:

- `packages/coding-agent/src/utils/external-editor.ts`
  - `openInEditor`

Coverage gap: current editor tests do not assert wait-flag injection or duplicate
suppression.

## 5. MCP startup timing diagnostics

Set `PI_MCP_TIMING=1` to print a per-server startup table to stderr after the initial
MCP startup race. It separates:

- connection/auth/spawn/initialize time
- `tools/list` time
- total time
- tool count
- deferred/error status

Implementation:

- `packages/coding-agent/src/mcp/manager.ts`
  - timing map inside `MCPManager.connectServers`
  - entries begin before auth resolution/connect
  - success and failure paths record connection time
  - tool listing records duration/count
  - rows sort slowest-first and print under `[PI_MCP_TIMING]`

This is diagnostics only. It must have effectively zero behavior/cost when the
environment variable is unset. It does not configure per-tool MCP timeouts.

Coverage gap: no automated timing-table test.

## 6. Safe agent frontmatter serialization

Agent prompt frontmatter contains values that may need YAML/JSON-safe quoting.

Implementation:

- `packages/utils/src/prompt.ts`
  - registers Handlebars helper `jsonStringify`
- consumer:
  - `packages/coding-agent/src/prompts/agents/frontmatter.md`

The helper returns `JSON.stringify(value)`. Preserve it while the prompt references
`{{jsonStringify ...}}`; otherwise prompt rendering fails or unsafe scalar text leaks
into frontmatter.

Coverage gap: no focused helper/frontmatter escaping test.

## 7. Local ignore policy

The fork's `.gitignore` includes local artifacts such as `*.har`, `*.bat`, `.nucleus`,
`.turbo`, benchmark runs, native backup binaries, parallel worktrees, CPU notes, and
TLS-capture output. These entries are convenience/tooling policy, not runtime
behavior. Reapply only entries still relevant to the maintainer environment and avoid
duplicates such as the historical repeated `/runs/` entry.

## 8. Windows Chrome headless launch stability

**Symptom.** Default `browser`/`xd://browser` headless launch finds the installed
Chrome executable but Puppeteer reports:

```text
Failed to launch the browser process: Code: 0
```

Passing Chrome through `app.path` works because that selects the spawned/CDP attach
backend and bypasses `launchHeadlessBrowser`; this does not prove executable
discovery is broken.

**Root cause.** The stealth launch list suppressed Puppeteer's
`--enable-automation` default. Current Windows Chrome can then exit cleanly before
opening its CDP endpoint, with no stderr. Direct probes reproduced failure three of
three times with the flag suppressed and success three of three times with it
retained.

**Contract.**

- Windows keeps Puppeteer's `--enable-automation` default for Chrome/Chromium.
- Microsoft Edge keeps it on every platform.
- Other non-Edge platforms may continue suppressing it.
- `--disable-blink-features=AutomationControlled` remains responsible for masking
  `navigator.webdriver`.

Implementation:

- `packages/coding-agent/src/tools/browser/launch.ts`
  - `stealthIgnoreDefaultArgs`
- `packages/coding-agent/test/tools/browser-launch.test.ts`
  - asserts Windows/Edge flag policy
- `packages/coding-agent/test/tools/browser-tab-evaluate.test.ts`
  - launches the default real-browser backend and exercises page evaluation

Verification:

```sh
(cd packages/coding-agent && bun test \
  test/tools/browser-launch.test.ts \
  test/tools/browser-tab-evaluate.test.ts)
```

The verified repair passes six tests on Windows, including four real-browser
evaluation cases. Do not replace this with a hard-coded user Chrome path; preserve
normal system discovery and cached Chromium fallback.

## 9. Confirmed non-features and stale history

Do not recreate these from old branches unless a new requirement exists:

- no live fork-only OAuth callback/redirect implementation was found;
- old reduced OAuth provider lists were intentionally dropped;
- old Google Vertex environment-variable additions were intentionally dropped;
- old AppendOnlyContext/EventLoopKeepalive removal was intentionally dropped;
- old MCP stdio timeout abstraction was intentionally dropped;
- stale Google flatten-anyOf/tool-choice tests were intentionally dropped;
- `packages/coding-agent/src/internal-urls/docs-index.generated.ts` is generated
  output, not an implementation source; regenerate it from current docs;
- legacy bundled key/registry files were deleted upstream and must not be restored.

## Commit references

- `f26026115` — EPIPE, editor wait, prompt helper, and surviving runtime ports
- `121cbbe40` — Hindsight reflect timeout plus recall/reflect xdev pins
- `9a8062a7f` — merge-carried `PI_MCP_TIMING` instrumentation

## Focused verification

```sh
(cd packages/utils && bun test test/postmortem-epipe.test.ts)
(cd packages/coding-agent && bun test test/memory-tools.test.ts test/write-xdev-dispatch.test.ts)
```

Manual checks remain required for reflect timeout wiring, GUI wait injection, MCP
timing output, and frontmatter escaping until focused tests are added.
