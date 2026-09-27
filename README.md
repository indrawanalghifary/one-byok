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

For a second, third, etc. endpoint (VS Code's native UI only stores one per vendor):

1. Command Palette → **One-BYOK: Add Endpoint**
2. Enter a display name (e.g. "My Ollama")
3. Enter the base URL (e.g. `http://localhost:11434/v1`)
4. Enter the API key if required (leave blank for keyless servers)
5. Repeat for each endpoint.

All endpoints appear in the model picker with their name as a suffix (e.g. `llama3 · My Ollama`).
Use **One-BYOK: Remove Endpoint** to delete one.

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
| `oneByok.debugLogging` | `false` | Write verbose traces (request bodies, SSE chunks, tool calls/results, image conversion) to the output channel. Off by default — traces may contain prompt/response content |
| `oneByok.requestTimeoutMs` | `300000` | Request timeout in ms (5 min default) |

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
full conversation state, enabling iterative problem-solving in agent mode.

Detailed tracing (tool calls, tool results, request bodies, SSE chunks, image conversion)
is **off by default**. Enable `oneByok.debugLogging` to write these traces to the
**One-BYOK** output channel (View → Output → select "One-BYOK"). Because those traces
include prompt and response content, leave the setting off unless you are actively
debugging.

Errors, model-discovery results, and actions you trigger from the Command Palette are
always logged, so the channel stays useful without enabling debug mode.

## Advanced: MCP Server Integration (Future)

Model Context Protocol (MCP) support is on the roadmap for providing even richer tool access:
- File system operations beyond basic listing
- Custom project-specific tools
- Standardized tool schemas for consistent behavior

For now, tools are limited to what VS Code provides natively. Stay tuned for MCP server support!

## Troubleshooting

### Models don't appear / "Not configured"

1. Ensure you've added at least one endpoint via **Add model** (native UI) or **One-BYOK: Add Endpoint** (Command Palette).
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

### Enable debug logging

Set `oneByok.debugLogging` to `true` in settings for verbose output of all operations.

## Notes

- Vendor id is `one-byok`; diagnostics go to the **One-BYOK** output channel.
- Once this extension works, any old static custom endpoint entries in
  `chatLanguageModels.json` can be removed to avoid duplicate model listings.
- Workspace context is injected as a system message, so it counts toward your token limit.
