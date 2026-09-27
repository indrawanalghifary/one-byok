# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-09-27

### Added

- **Endpoint manager.** **One-BYOK: Manage Endpoints** replaces the separate
  add/remove commands with one picker: add, edit, test the connection to, or
  remove an endpoint, then continue working without re-running a command per
  change. The base URL is validated (scheme and duplicates), editing keeps the
  stored API key when the key field is left empty, and the API key is never
  pre-filled or displayed. Tested endpoints are marked in the list, so "which of
  my endpoints work?" is answerable at a glance.
- **One-BYOK: Open Settings** opens the Settings page filtered to `oneByok.*`,
  giving all 14 settings a form-based UI instead of hand-editing JSON.

### Changed

- The model list is refreshed by running a real `/models` discovery after an
  endpoint is added, edited or removed, instead of only invalidating the cache.
  Failures during that refresh are logged rather than swallowed silently.
- `oneByok.addEndpoint` and `oneByok.removeEndpoint` now open the endpoint
  manager, so exactly one code path writes `oneByok.endpoints`. The provider's
  `managementCommand` (the "Manage" link beside the vendor in the model picker)
  now points at the manager.

## [0.3.0] - 2026-09-27

### Added

- **Fallback models.** `oneByok.fallbackModels` takes an ordered list of backup
  model ids; when the selected model fails, each is tried in turn and a message
  names the model that actually answered. Entries accept `modelId @ <endpoint
  name or host>` when several endpoints expose the same id, and unknown ids are
  skipped with a warning. Disabled by default.
- **Automatic retries.** `oneByok.maxRetries` (default `2`) repeats the selected
  model on transient failures — network/DNS/timeout errors and HTTP
  `408`/`409`/`425`/`429`/`500`/`502`/`503`/`504` — with exponential backoff and
  jitter. Wrong credentials (`401`/`403`) and bad requests (`400`/`404`/`422`) are
  never retried. A `429` also pauses before the fallback model is tried.

### Fixed

- **Errors reported inside an HTTP 200 response are no longer ignored.** Gateways
  such as vLLM, LiteLLM and OpenRouter reply `200` and then send
  `{"error":{"message":"..."}}` — either as an SSE element or as a plain JSON
  body. Both were silently swallowed, so the request looked like it succeeded
  with an empty reply and the user saw only "Sorry, no response was returned."
  These are now treated as failures: they are retried, they trigger fallback, and
  the server's own message is surfaced (the raw body is quoted when there is no
  parseable message).
- **Fallback is refused once output has started.** If text has already reached
  the chat, retrying would duplicate it and switching models would append a
  contradictory answer, so the request fails with a clear explanation instead.
  Tool calls are unaffected because they are only delivered after the stream
  completes, so an interrupted tool call never runs twice.
- **HTTP error bodies are summarised, not dumped.** `{ error: { message } }`,
  `{ error: "..." }`, `{ message }`, `{ detail }` (FastAPI) and plain-text bodies
  are all parsed, so a failed request reads
  `chat/completions failed: HTTP 400 — The model \`ghost\` does not exist`
  instead of a raw 300-character JSON paste.
- **A `401`/`403` no longer wastes fallback attempts on the same host.** Every
  model behind rejected credentials would fail identically, so that endpoint's
  remaining fallbacks are skipped (fallbacks on *other* endpoints are still
  tried).
- Network failures now explain themselves. A failed request used to surface
  only as `fetch failed`, which gives no clue what went wrong. The real cause is
  now read from the error chain and included in both the chat error and the
  output channel, with a short hint — e.g. `ECONNRESET: socket hang up` plus
  "commonly a flaky tunnel or proxy". Recognised causes: `ENOTFOUND`/`EAI_AGAIN`,
  `ECONNREFUSED`, `ECONNRESET`/`EPIPE`, `ETIMEDOUT`, `UND_ERR_*` and TLS
  certificate errors. Model-discovery warnings include the cause too.
- **`debugLogging` is now honoured.** The setting was previously declared but
  never read, so the extension always wrote verbose traces (request bodies, SSE
  chunks, tool calls/results, image conversion) to the output channel. Those
  traces are now emitted at **Debug** level and stay hidden by default; set
  `oneByok.debugLogging` to `true` to reveal them.
- **Silent image failures are no longer silent.** An image part that cannot be
  decoded, or a binary part that arrives in an unrecognised shape, now logs a
  **warning** instead of being dropped quietly, so a "vision does not work"
  report is diagnosable from the output channel.

### Changed

- **Logging uses severity levels.** The output channel is now a VS Code
  `LogOutputChannel`, so lines are tagged *Info*, *Warning*, *Error* or *Debug*
  and can be filtered from the level dropdown in the Output panel. Previously
  every line was written as undifferentiated text.
- **Model discovery failures log as warnings** rather than plain info.
- **A level picked manually in the Output panel is preserved** across window
  reloads; `oneByok.debugLogging` only overrides it when enabled or explicitly
  changed.
- **Rebranded to One-BYOK.** The extension is now published as
  `one-byok.one-byok` with display name **One-BYOK**; the vendor id changed
  from `byok-models` to `one-byok` and the output channel from **BYOK Models**
  to **One-BYOK**.
- **Settings and commands renamed.** All `byokModels.*` settings are now
  `oneByok.*` (`oneByok.endpoints`, `oneByok.baseUrl`, `oneByok.apiKey`,
  `oneByok.enableTools`, `oneByok.enableVision`, `oneByok.forceVision`,
  `oneByok.injectWorkspaceContext`, `oneByok.maxWorkspaceContextChars`,
  `oneByok.maxInputTokens`, `oneByok.maxOutputTokens`,
  `oneByok.requestTimeoutMs`, `oneByok.debugLogging`), and all
  `byokModels.*` commands are now `oneByok.*`. Entries in this changelog
  below this section refer to the previous names.
- **Secret key renamed** from `byokModelsApiKey` to `oneByokApiKey`. A
  previously stored API key must be set again via **One-BYOK: Set API Key**.

## [0.2.20] - 2026-08-31

### Added

- **Multiple provider endpoints**: the extension was limited to a single endpoint
  per vendor — VS Code only stores one `baseUrl`/API key per vendor. A new
  `byokModels.endpoints` setting (array of `{baseUrl, apiKey, name?}`) plus
  **BYOK Models: Add Endpoint** and **BYOK Models: Remove Endpoint** commands
  let you register any number of OpenAI-compatible endpoints (Ollama, LM Studio,
  vLLM, …). Models from every endpoint are aggregated into the picker, each
  labelled with its endpoint name (or the URL host when unnamed).
- **Named endpoints**: **Add Endpoint** asks for a display name first, then the
  base URL, then the key. The name becomes the model label suffix (e.g. `llama3 · My Ollama`).
- **Native Add-model dialog collects a name**: the `languageModelChatProviders`
  configuration schema includes an optional `name` field, so the native **Add model**
  dialog also accepts a display name alongside base URL and API key.
- **Keyless local endpoints**: the `Authorization` header is only sent when a key
  is actually present, so keyless servers (Ollama, LM Studio) work without a
  dummy key.

### Changed

- **Native "Add model" button always opens Add Endpoint form**: clicking the
  native **Add model** button runs the **BYOK Models: Add Endpoint** name-first
  form directly (no intermediate notification). Works even when endpoints already
  exist — the form runs async and `fireChanged()` refreshes the picker after
  adding.
- **Endpoints persist reliably**: `byokModels.endpoints` is stored at
  **application scope** and written with error handling, so added endpoints
  survive across workspaces instead of being silently dropped. The provider
  **Manage** button opens the Add Endpoint flow.
- **Single source of truth**: model discovery reads endpoints only from
  `byokModels.endpoints`. VS Code's native Add-model UI store
  (`options.configuration` / `chat.lm.secret.*`) is ignored — it's opaque,
  can't be cleared from extension code, and would keep feeding stale values.
- **Default `requestTimeoutMs`**: `120000` → `300000` (5 min) so slow local
  models aren't cut off mid-generation.

### Fixed

- **Abort error message not translated**: the friendly timeout/cancellation hint
  now matches Node/undici's `'This operation was aborted'` message (regex covers
  all variants) instead of leaking the raw error.
- **Legacy secret storage no longer shadows discovery**: the fallback to the old
  single-endpoint secret (`byok-models.baseUrl`) was removed, so a stale junk
  URL from an earlier test can't block the Add Endpoint form or fail discovery.

## [0.2.9] - 2026-08-26

### Added

- **Dynamic context window adaptation**: Model context window is now read from
  `/v1/models` metadata (supports `context_window`, `max_context_length`,
  `max_tokens`, `n_ctx` fields from vLLM, Ollama, LM Studio, etc.). The
  extension automatically:
  - Sets `maxInputTokens`/`maxOutputTokens` per-model based on declared limits
  - Calculates workspace context budget as 25% of context window (capped by
    `maxWorkspaceContextChars` setting)
  - Disables workspace context injection by default for safer local inference
- **Per-model context window display**: Model detail in picker now shows
  discovered context window (e.g., "context: 112,896 tokens")

### Changed

- **Default `injectWorkspaceContext`**: `true` → `false` (opt-in for local models)
- **Default `maxWorkspaceContextChars`**: `2000` → `500` (conservative for small models)

## [0.2.7] - 2026-08-26

### Fixed

- **Tool call arguments passed as string instead of object**: `LanguageModelToolCallPart`
  requires the `args` parameter to be a parsed JavaScript object, but the
  extension was passing the accumulated JSON string. This caused VS Code to
  reject every tool call with "must be object". Now the arguments are parsed into
  an object before being reported.

## [0.2.6] - 2026-08-26

### Added

- **Request timeout**: configurable `requestTimeoutMs` (default 120000ms / 2 min)
- **Context cap**: `maxInputTokens`/`maxOutputTokens` settings with model-declared limits
- **Tool call validation**: stricter parsing of tool call arguments

## [0.2.5] - 2026-08-25

### Added

- **Model discovery cache**: 30s TTL to avoid redundant `/v1/models` fetches
- **Silent call log suppression**: background refresh calls don't produce noisy output
- **Management command**: native UI gear button opens BYOK Models: Set API Key

## [0.2.4] - 2026-08-24

### Changed

- Clean marketplace publish with neutral branding

## [0.2.3] - 2026-08-24

### Fixed

- Surface response errors properly
- Flush SSE buffer on stream completion
- Protect activation against missing config

## [0.2.2] - 2026-08-23

### Fixed

- Command registration for VS Code marketplace

## [0.2.1] - 2026-08-22

### Added

- Initial release: zero-touch dynamic model provider for OpenAI-compatible endpoints
- Live model discovery from `/v1/models`
- Workspace context injection
- Tool calling pass-through
