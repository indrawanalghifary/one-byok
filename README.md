# One-BYOK

**One-BYOK** is a VS Code extension that enables GitHub Copilot to use your own
**OpenAI-compatible API provider**.

Bring your own API **Base URL** and **API Key**, and One-BYOK automatically
discovers the available models from your provider and configures vision
capabilities based on the selected model.

Models are discovered live from `/v1/models` on every model-picker refresh —
when the server adds, removes, or renames a model, the picker follows
automatically. No scripts, no manual syncing.

## ✨ Features

- 🔑 **Bring Your Own Key** — Use your own API key instead of relying solely on the default provider.
- 🌐 **Custom Base URL** — Connect to any OpenAI-compatible API endpoint.
- 🤖 **Automatic Model Discovery** — Fetch and detect available models from the configured provider.
- 👁️ **Automatic Vision Support** — Detect whether a model supports image/vision input and expose the capability accordingly.
- 🔄 **Provider Agnostic** — Designed to work with APIs that follow the OpenAI-compatible API format.
- ⚙️ **VS Code Integration** — Designed specifically to integrate with the VS Code Copilot workflow.
- 🧩 **Multiple Endpoints** — Register any number of endpoints; models from all of them are aggregated in the picker, each labelled with its endpoint name.
- 📁 **Optional Workspace Context** — Inject workspace metadata (active files, git branch, project structure) into system prompts so models understand your project.
- 🛠️ **Tool Calling** — Pass tool calls through to the endpoint, so Copilot agent mode works when the model supports it.

## 🎯 Use Case

One-BYOK is useful when you want to use Copilot with:

- Self-hosted OpenAI-compatible APIs
- Local LLM servers
- Custom AI gateways
- Alternative OpenAI-compatible providers
- Your own API endpoint and credentials

Configure your **Base URL** and **API Key**, and let One-BYOK handle model
discovery and capability detection automatically.

## Compatible providers

Works with **any** OpenAI-compatible endpoint — just point it at a base URL ending in `/v1`
and it will discover models automatically. Designed for local inference, but works with
remote endpoints too. Tested and compatible with:

- **[Ollama](https://ollama.com/)** — `http://localhost:11434/v1`
- **[LM Studio](https://lmstudio.ai/)** — `http://localhost:1234/v1`
- **[vLLM](https://github.com/vllm-project/vllm)** — `http://localhost:8000/v1`
- **[LocalAI](https://localai.io/)** — `http://localhost:8080/v1`
- **[llama.cpp server](https://github.com/ggerganov/llama.cpp)** — `http://localhost:8080/v1`
- **[Text Generation WebUI](https://github.com/oobabooga/text-generation-webui)** — `http://localhost:5000/v1`
- **[Unsloth](https://github.com/unslothai/unsloth)** — any self-hosted or cloud endpoint
- **[OpenRouter](https://openrouter.ai/)** — `https://openrouter.ai/api/v1`
- Any cloud provider with an OpenAI-compatible API (Azure, together.ai, fireworks.ai, etc.)

If it serves `/v1/models` and `/v1/chat/completions`, it works.

## Install

```bash
npx @vscode/vsce package --allow-missing-repository
```

Then in VS Code: Extensions view → `⋯` → **Install from VSIX…** → pick the generated
`one-byok-<version>.vsix`, and reload the window.

## Configure

### Option 1: Native "Add model" (first endpoint)

1. Open AI Chat → **Manage Models** → **Add model** → **One-BYOK**
2. Enter a **Name** (e.g. "My Ollama"), **Base URL** (`http://localhost:11434/v1`), **API Key** (or leave empty for keyless servers like Ollama/LM Studio)
3. Done — models appear in the picker.

### Option 2: Command Palette (any number of endpoints)

Run **One-BYOK: Manage Endpoints** from the Command Palette (`Ctrl+Shift+P`). The manager lets you:

- **Add** an endpoint — name, base URL and API key. The URL is validated (must start with
  `http://` or `https://`, duplicates are rejected).
- **Edit** an endpoint — the stored API key is kept when you leave the key field empty, and it
  is never pre-filled or displayed.
- **Test connection** — calls `<baseUrl>/models` and reports how many models came back, or the
  server's own error message. Checked endpoints are marked in the list with a check or a warning
  icon, so "which of my endpoints work?" is answerable at a glance.
- **Remove** an endpoint — behind a confirmation dialog.

The model list refreshes automatically after every change, so no manual refresh is needed.

> **One-BYOK: Open Settings** opens the Settings page filtered to every `oneByok.*` option — all
> 14 of them are editable there with normal checkboxes and fields.

All endpoints appear in the model picker with their name as a suffix (e.g. `llama3 · My Ollama`).
Open **One-BYOK: Manage Endpoints** again at any time to edit, test or remove one.

## Use

Open AI Chat → model picker → **One-BYOK** section. All models reported by every
configured endpoint appear there dynamically. Tool calling is passed through (agent mode
works) when the endpoint supports it; disable via `oneByok.enableTools`.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `oneByok.endpoints` | `[]` | Array of `{baseUrl, apiKey, name?}` — primary multi-endpoint config |
| `oneByok.baseUrl` | *(empty)* | Legacy single-endpoint base URL (fallback) |
| `oneByok.apiKey` | *(empty)* | Legacy single-endpoint API key (fallback) |
| `oneByok.maxInputTokens` | `262144` | Fallback context window (overridden by model's declared limit) |
| `oneByok.maxOutputTokens` | `32768` | Fallback max output (overridden by model's declared limit) |
| `oneByok.enableTools` | `true` | Advertise + pass through tool calling |
| `oneByok.enableVision` | `true` | Advertise + pass through image/vision input for models that support it |
| `oneByok.forceVision` | `false` | Advertise image input for **all** models (only for gateways that reroute images to a vision-capable upstream) |
| `oneByok.injectWorkspaceContext` | `false` | Inject workspace metadata (files, git, project structure) into system prompts — **disabled by default for local models** |
| `oneByok.maxWorkspaceContextChars` | `500` | Max chars for workspace context (capped at 25% of model's context window) |
| `oneByok.debugLogging` | `false` | Raise the output channel to **Debug** level (request bodies, SSE chunks, tool calls/results, image conversion). Off by default — traces may contain prompt/response content |
| `oneByok.requestTimeoutMs` | `300000` | Request timeout in ms (5 min default) |
| `oneByok.maxRetries` | `2` | How many times to retry the **selected** model on a transient failure. `0` disables retrying |
| `oneByok.fallbackModels` | `[]` | Ordered list of backup model ids. **Empty = disabled** (default) |

## Reliability: retries and fallback models

Requests can fail for reasons that have nothing to do with the prompt: a tunnel drops,
a gateway rate-limits, or a model is briefly overloaded. Two opt-in layers handle that.

### Retrying the same model

`oneByok.maxRetries` (default `2`) repeats the request against the **same** model when the
failure looks transient:

| Retried | Not retried |
|---|---|
| Network errors, DNS failures, timeouts | HTTP `401`/`403` (wrong API key) |
| HTTP `408`, `409`, `425`, `429`, `500`, `502`, `503`, `504` | HTTP `400`, `404`, `422` (bad model, bad request) |

Backoff uses exponential delay with jitter, capped at 4 seconds. A `429` (or any 5xx) adds a
short pause before the fallback model is tried, so a throttled upstream is not hammered again.

### Falling back to another model

Set `oneByok.fallbackModels` to an ordered list of model ids to try when the selected model
ultimately fails:

```json
{
  "oneByok.maxRetries": 2,
  "oneByok.fallbackModels": ["qwen3-coder-30b", "llama-3.3-70b"]
}
```

Each entry is tried in order. If several endpoints expose the same model id, disambiguate with
`@`:

```json
{ "oneByok.fallbackModels": ["qwen3-coder @ ollama.local", "gpt-4o @ work-gateway"] }
```

The part after `@` matches an endpoint's `name` or its host. Entries that match nothing are
skipped with a warning instead of breaking the chain. Fallback models are only used if they are
reachable through an endpoint listed in `oneByok.endpoints`.

**When you are told.** A silent substitution would be confusing, so whenever a fallback model
answers you get a message naming both models, and the same detail is written to the output
channel.

### Why fallback stops once a reply has started

Fallback is only attempted **before the first part of the reply is streamed**. Once text has
reached the chat, switching models would append a second, contradictory answer under a
half-finished one, so the request fails with an explanation instead:

```
One-BYOK: gateway dropped — output had already started streaming,
so the request cannot be retried or replaced by a fallback model.
```

Tool calls are not affected by this rule: they are handed to the chat only after the stream
finishes, so an interrupted tool call was never delivered and can never run twice.

### Errors hidden inside HTTP 200

Some gateways (vLLM, LiteLLM, Ollama, OpenRouter) reply `200` and then report the failure *in*
the response body or as an SSE element:

```json
{"error": {"message": "vllm: out of memory", "code": "oom"}}
```

That is now treated as a real failure. It is retried, it triggers fallback, and the server's own
message is shown rather than the bare "no response was returned" it used to produce. The same
applies when a gateway returns `200` with a plain JSON body instead of an SSE stream — the body
is quoted so you can see what it actually said.

## Dynamic Context Window Adaptation (v0.2.9+)

The extension now **automatically reads the model's context window** from `/v1/models` metadata during discovery. Supported fields (checked in order):

- `context_window` (vLLM)
- `max_context_length` (Ollama)
- `max_tokens` (LM Studio)
- `n_ctx` (llama.cpp)

When a model declares its context window, the extension:
1. **Sets `maxInputTokens`/`maxOutputTokens` per-model** — uses the declared limit (with 25% reserved for output)
2. **Calculates workspace context budget dynamically** — 25% of context window × 4 chars/token, capped by `maxWorkspaceContextChars`
3. **Shows context window in model picker** — detail displays e.g., "context: 112,896 tokens"

This prevents "context window exceeded" errors with local models that have smaller limits.

## Workspace Context Injection

When `oneByok.injectWorkspaceContext` is enabled (default: **false** for local models), the extension automatically
injects workspace metadata into your model's system prompt:

- **Active file** — current editor, language, line count
- **Open files** — tabs currently visible in VS Code
- **Workspace folders** — project structure and root paths
- **Git info** — current branch, uncommitted changes count

The injected context is **dynamically sized** based on the model's declared context window (25% budget, capped at `maxWorkspaceContextChars`). For a model with 112,896 tokens, that's ~112K chars budget (capped at 500 by default).

This allows your models to provide **context-aware assistance** without requiring you to manually
describe your project. The model understands:

- Which files you're working on
- Your project structure
- Your git branch and uncommitted work
- Your code organization

### Example System Prompt with Context

```
=== Workspace Context ===
Workspace folders: my-app
Root: /home/user/projects/my-app
Active file: src/components/Button.tsx (typescript)
  Lines: 45, Modified: yes
Open files:
  src/components/Button.tsx (typescript)
  src/styles/Button.css (css)
  tests/Button.test.tsx (typescript)
Git branch: feature/dark-mode
  Changes: 3 modified, 1 staged
```

### Debugging Workspace Context

Use the command **One-BYOK: Show Workspace Context** (Command Palette → search "One-BYOK")
to see exactly what context will be injected. This is useful for understanding why models respond
the way they do, or for troubleshooting if context isn't being picked up.

## Tool Calling & Multi-Turn Interactions

Tool calls and results are passed through faithfully, and multi-turn flows preserve the
full conversation state, enabling iterative problem-solving in agent mode. Tracing of
those flows is available — see [Logging](#logging).

## Logging

The **One-BYOK** output channel (View → Output → select "One-BYOK") uses VS Code log
levels, so you can filter it from the level dropdown in the Output panel:

| Level | Contents |
|---|---|
| **Info** | Activation, model discovery results, and actions you trigger from the Command Palette |
| **Warning** | Non-fatal degradations you should notice — e.g. an image part that could not be converted and was therefore dropped, or workspace context that failed to gather |
| **Error** | Failed chat requests, with the underlying cause |
| **Debug** | Verbose traces: request bodies, SSE chunks, tool calls/results, image conversion details |

Only Info and above are emitted by default. Set `oneByok.debugLogging` to `true` to raise
the level to **Debug** — because traces include prompt and response content, leave it off
unless you are actively debugging. You can also pick a level manually from the Output panel
dropdown; that choice is kept across window reloads unless you change `oneByok.debugLogging`
again.

The channel is in-memory only: nothing is written to disk, and no server or MCP endpoint is
exposed. To share a log, copy it from the Output panel.

## Advanced: MCP Server Integration (Future)

Model Context Protocol (MCP) support is on the roadmap for providing even richer tool access:
- File system operations beyond basic listing
- Custom project-specific tools
- Standardized tool schemas for consistent behavior

For now, tools are limited to what VS Code provides natively. Stay tuned for MCP server support!

## Troubleshooting

### Models don't appear / "Not configured"

1. Ensure you've added at least one endpoint via **Add model** (native UI) or **One-BYOK: Manage Endpoints** (Command Palette).
2. Check the **One-BYOK** output channel — it logs the base URL/key source used for discovery (`setting:oneByok.endpoints`, `secret:...`, or `setting:...`).
3. Run **One-BYOK: Refresh Model List** after changing the configuration.
4. If you see duplicate empty entries (e.g. `one-byok 2`), delete them via the gear icon next to the provider in **Manage Models**.

### Models aren't receiving workspace context

1. Check that `oneByok.injectWorkspaceContext` is set to `true` in settings.
2. Run **One-BYOK: Show Workspace Context** to verify context is being detected.
3. Check the **One-BYOK** output channel for errors or warnings.

### Tool calls aren't working

1. Verify `oneByok.enableTools` is `true`.
2. Ensure your endpoint supports OpenAI's tool-calling format.
3. Check the **One-BYOK** output channel for tool call logs and errors.

### "Could not reach the endpoint"

When a request fails at the network level, the message names the underlying cause
instead of the unhelpful bare `fetch failed`:

```
One-BYOK: Could not reach the endpoint (ECONNRESET: socket hang up).
The connection was reset mid-request — commonly a flaky tunnel or proxy.
Retry, or point at a more stable endpoint.
```

Recognised causes and what they mean:

| Cause | Meaning |
|---|---|
| `ENOTFOUND` / `EAI_AGAIN` | Host name could not be resolved — check the Base URL host and your DNS |
| `ECONNREFUSED` | Nothing is listening on that host/port, or a firewall blocked it |
| `ECONNRESET` / `socket hang up` | Connection reset mid-request — often a flaky tunnel or proxy |
| `ETIMEDOUT` / connect timeout | Endpoint is slow or unreachable |
| `CERT_*` / TLS errors | The endpoint's certificate is not trusted by this machine |

Note that model discovery and chat requests are separate calls, so it is possible for
discovery to succeed while a chat request fails — a symptom of an unstable endpoint
rather than a misconfiguration. The same detail is written to the output channel, so
enabling `oneByok.debugLogging` gives you the full picture.

### Enable debug logging

Set `oneByok.debugLogging` to `true` in settings for verbose output of all operations.

## Notes

- Vendor id is `one-byok`; diagnostics go to the **One-BYOK** output channel.
- Once this extension works, any old static custom endpoint entries in
  `chatLanguageModels.json` can be removed to avoid duplicate model listings.
- Workspace context is injected as a system message, so it counts toward your token limit.
