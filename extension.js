'use strict';

/**
 * One-BYOK — zero-touch dynamic language model provider for VS Code AI Chat.
 *
 * - Models are discovered live from `<baseUrl>/models` every time VS Code asks
 *   (provideLanguageModelChatInformation), so the picker always matches the server.
 * - Chat requests are streamed from `<baseUrl>/chat/completions` (SSE) and translated
 *   into LanguageModelTextPart / LanguageModelToolCallPart progress reports.
 * - The API key lives in VS Code secret storage (set via the "One-BYOK: Set API Key"
 *   command), with an optional plaintext fallback in `oneByok.apiKey`.
 * - Workspace context (active files, git info, project structure) is injected into
 *   system prompts to give models awareness of the user's project context.
 * - Tool results are logged and preserved across multi-turn interactions.
 */

const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');

const VENDOR = 'one-byok';
const SECRET_KEY = 'oneByokApiKey';
// Key name VS Code uses when storing credentials entered through the native
// "Add model" (Manage Models) UI — mirrors the opencodego pattern (<vendor>.<property>).
const MANAGED_SECRET_KEY = `${VENDOR}.apiKey`;

/** @type {vscode.LogOutputChannel | undefined} */
let channel;

function ensureChannel() {
  if (!channel) {
    // `log: true` gives the channel severity levels, automatic timestamps and a
    // level picker in the Output panel instead of a single undifferentiated stream.
    channel = vscode.window.createOutputChannel('One-BYOK', { log: true });
  }
  return channel;
}

/** Informational, always shown: activation and user-triggered actions. */
function logInfo(message) {
  ensureChannel().info(message);
}

/** Warning, always shown: a non-fatal degradation the user should notice. */
function logWarn(message) {
  ensureChannel().warn(message);
}

/** Error, always shown. Pass the caught error to include its message and cause. */
function logError(message, err) {
  if (err === undefined) {
    ensureChannel().error(message);
    return;
  }
  // Network errors surface as a bare "fetch failed"; the reason lives in cause.
  const cause = describeErrorCause(err);
  ensureChannel().error(
    `${message}: ${err?.message ?? err}${cause ? ` (cause: ${cause})` : ''}`
  );
}

/**
 * Verbose trace: request bodies, SSE chunks, image conversion details and
 * tool-call parsing. Emitted at `debug` level, so it stays hidden unless the
 * channel level is raised — `oneByok.debugLogging` does that automatically.
 * Trace lines can contain prompt/response content, which is why they are off
 * by default.
 */
function logDebug(message) {
  ensureChannel().debug(message);
}

/**
 * Sync the channel level with `oneByok.debugLogging`.
 *
 * The level is only written when the setting is enabled, or when reacting to an
 * explicit change (`explicit`), so a level picked manually from the Output
 * panel survives window reloads.
 *
 * @param {boolean} explicit - true when called in response to a settings change.
 */
function applyDebugLoggingSetting(explicit) {
  let enabled = false;
  try {
    enabled = settings().get('debugLogging', false) === true;
  } catch {
    enabled = false;
  }
  if (!enabled && !explicit) {
    // Never silently lower a level the user may have chosen themselves.
    return;
  }
  ensureChannel().logLevel = enabled ? vscode.LogLevel.Debug : vscode.LogLevel.Info;
}

// No built-in endpoint: users configure their own OpenAI-compatible server
// via `oneByok.baseUrl` or the Add-model UI (`one-byok.baseUrl` secret).
const DEFAULT_BASE_URL = '';

// Cache TTL for model discovery results (30 seconds). Avoids redundant
// /v1/models fetches when VS Code calls provideLanguageModelChatInformation
// multiple times in rapid succession (e.g., model picker refreshes).
const MODEL_CACHE_TTL_MS = 30_000;

function trimUrl(url) {
  const value = String(url ?? '').trim();
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

/**
 * Collect every `cause` in a fetch error chain into one line.
 *
 * `fetch()` throws a bare `TypeError: fetch failed` and hides the real reason
 * (ECONNRESET, ETIMEDOUT, ENOTFOUND, CERT_*…) in `err.cause`, sometimes nested
 * several levels deep. Without this, a network failure is indistinguishable
 * from any other error.
 *
 * @param {unknown} err
 * @returns {string} e.g. "ECONNRESET: socket hang up" or '' when nothing is found.
 */
function describeErrorCause(err) {
  const parts = [];
  const seen = new Set();
  let current = err?.cause;
  while (current && parts.length < 4 && !seen.has(current)) {
    seen.add(current);
    const code = typeof current.code === 'string' ? current.code : '';
    const message = typeof current.message === 'string' ? current.message : '';
    const text = [code, message].filter(Boolean).join(': ');
    if (text && !parts.includes(text)) {
      parts.push(text);
    }
    current = current.cause;
  }
  return parts.join(' ← ');
}

/**
 * Turn a network-level failure into something the user can act on.
 * @param {string} cause
 * @returns {string|undefined} A hint, or undefined when the cause is unrecognised.
 */
function networkHint(cause) {
  if (!cause) {
    return undefined;
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(cause)) {
    return 'The host name could not be resolved — check the base URL host for typos, and your DNS/network.';
  }
  if (/ECONNREFUSED/i.test(cause)) {
    return 'The host refused the connection — the server is not listening on that port, or a firewall is blocking it.';
  }
  if (/ECONNRESET|EPIPE|socket hang up/i.test(cause)) {
    return 'The connection was reset mid-request — commonly a flaky tunnel or proxy. Retry, or point at a more stable endpoint.';
  }
  if (/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|headers timeout|body timeout/i.test(cause)) {
    return 'The connection timed out — the endpoint may be slow or unreachable right now.';
  }
  if (/CERT_|ERR_TLS|self.signed|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(cause)) {
    return 'TLS certificate validation failed — the endpoint uses a certificate this machine does not trust.';
  }
  if (/UND_ERR_SOCKET/i.test(cause)) {
    return 'The socket closed unexpectedly — usually a network interruption or a proxy dropping the connection.';
  }
  return undefined;
}

/**
 * Mark an error as "output already reached the chat".
 *
 * Once a text part has been reported, a retry would duplicate it and a failover
 * would replace half a sentence the user is already reading, so the
 * orchestration layer refuses to continue and fails honestly instead.
 *
 * Note that tool calls are deliberately NOT part of this check: they are only
 * handed to the chat after the whole stream completes, so an interrupted tool
 * call was never delivered and cannot be executed twice.
 *
 * @param {unknown} err
 * @param {boolean} started - Whether any part was already reported.
 * @returns {Error}
 */
function throwWithStreaming(err, started) {
  const error = err instanceof Error ? err : new Error(String(err));
  if (started) {
    error.streamingStarted = true;
  }
  return error;
}

/** An HTTP response with a non-2xx status, carrying the parsed server message. */
class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message - Already-parsed server message, not raw JSON.
   * @param {string} [body] - Raw body, kept for debug logging only.
   */
  constructor(status, message, body) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

/** HTTP statuses worth trying again: rate limits and transient upstream failures. */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/**
 * Pull a human-readable message out of an error response body.
 *
 * OpenAI-compatible servers disagree on shape — `{ error: { message } }`,
 * `{ error: "..." }`, `{ message }`, `{ detail }` (FastAPI), or a plain text
 * body. Pasting the raw JSON into the chat is unreadable, so normalise here.
 *
 * @param {unknown} payload - Parsed JSON, a JSON string, or raw text.
 * @returns {string} '' when no message could be extracted.
 */
function errorMessageFromBody(payload) {
  if (payload === undefined || payload === null) {
    return '';
  }
  let value = payload;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) {
      return '';
    }
    // A JSON string that failed to parse upstream is still worth probing.
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        const nested = errorMessageFromBody(JSON.parse(text));
        if (nested) {
          return nested;
        }
      } catch {
        // Not valid JSON after all — fall through and use the raw text.
      }
    }
    return text;
  }
  if (typeof value !== 'object') {
    return String(value);
  }
  const obj = /** @type {Record<string, any>} */ (value);
  // `error` may itself be a string, an object, or a nested array (LiteLLM-style).
  if (obj.error !== undefined && obj.error !== null) {
    if (typeof obj.error === 'object') {
      const inner = obj.error.message ?? obj.error.detail ?? obj.error.code;
      if (inner) {
        return errorMessageFromBody(inner);
      }
    } else {
      const nested = errorMessageFromBody(obj.error);
      if (nested) {
        return nested;
      }
    }
  }
  for (const key of ['message', 'detail', 'reason', 'error_description', 'msg']) {
    if (obj[key]) {
      const nested = errorMessageFromBody(obj[key]);
      if (nested) {
        return nested;
      }
    }
  }
  return '';
}

/**
 * Decide whether a failure is worth retrying (same model) or failing over
 * (another model), and describe it succinctly.
 *
 * @param {unknown} err
 * @returns {{ kind: 'streaming'|'server'|'network'|'auth'|'fatal', retryable: boolean, status?: number, detail: string }}
 */
function classifyError(err) {
  const status = typeof err?.status === 'number' ? err.status : undefined;
  const cause = describeErrorCause(err);
  const message = String(err?.message ?? err ?? '');
  if (err?.streamingStarted) {
    // Output already reached the chat — nothing may be replayed.
    return { kind: 'streaming', retryable: false, status, detail: message };
  }
  if (status !== undefined) {
    if (status === 401 || status === 403) {
      // Wrong/expired key: retrying another model on the same endpoint is futile.
      return { kind: 'auth', retryable: false, status, detail: message };
    }
    if (RETRYABLE_STATUS.has(status)) {
      return { kind: 'server', retryable: true, status, detail: message };
    }
    // 400/404/422 and friends: wrong model name, unsupported parameter. Another
    // model on the same endpoint is a genuinely sensible next step.
    return { kind: 'fatal', retryable: false, status, detail: message };
  }
  if (/aborted|terminated|timed? ?out/i.test(message) && !cause) {
    return { kind: 'network', retryable: false, status, detail: message };
  }
  // No HTTP status at all means the request never completed a round trip
  // (DNS, TCP, TLS, reset tunnel) — the cheapest failures to retry.
  return { kind: 'network', retryable: true, status, detail: cause ? `${message} (${cause})` : message };
}

/** Exponential backoff with jitter, capped so a fallback never feels hung. */
function retryDelayMs(attempt) {
  const base = Math.min(500 * 2 ** attempt, 4000);
  return base + Math.floor(Math.random() * 250);
}

/** Await a duration; used for retry backoff. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Values entered through VS Code's native "Add model" UI are stored by VS Code
 * itself (secrets under internal `chat.lm.secret.*` keys, the rest in its
 * language-models config file) and handed to the provider via
 * `options.configuration` on every provideLanguageModelChatInformation call.
 * This is not in the stable vscode.d.ts yet, but the extension host forwards it.
 * We deliberately do NOT read it as an endpoint source — see resolveEndpoints.
 */

async function resolveBaseUrl(context) {
  const managed = ((await context.secrets.get(`${VENDOR}.baseUrl`)) ?? '').trim();
  if (managed) {
    return { url: managed.endsWith('/') ? managed.slice(0, -1) : managed, source: `secret:${VENDOR}.baseUrl` };
  }
  const configured = String(settings().get('baseUrl', '') || '').trim();
  if (configured) {
    return { url: configured.endsWith('/') ? configured.slice(0, -1) : configured, source: 'setting:oneByok.baseUrl' };
  }
  return { url: DEFAULT_BASE_URL, source: 'default' };
}

/**
 * All configured endpoints. Only the `oneByok.endpoints` setting is used —
 * the native Add-model UI store (options.configuration) is deliberately NOT read:
 * VS Code hands us whatever the user typed there forever (including junk or a
 * cancelled half-edit), and there is no stable API to clear it, so a stale native
 * value could shadow our setting and block the Add Endpoint form.
 * @returns {{ baseUrl: string, apiKey: string, name: string, source: string }[]}
 */
function resolveEndpoints() {
  const out = [];
  const extra = Array.isArray(settings().get('endpoints', []))
    ? settings().get('endpoints', [])
    : [];
  for (const e of extra) {
    const url = trimUrl(e?.baseUrl);
    if (url) {
      out.push({
        baseUrl: url,
        apiKey: String(e?.apiKey ?? '').trim(),
        name: endpointName(e?.name, url),
        source: 'setting:oneByok.endpoints',
      });
    }
  }
  return out;
}

/** Friendly label for an endpoint: explicit name, else its host, else the URL. */
function endpointName(name, baseUrl) {
  const n = String(name ?? '').trim();
  if (n) {
    return n;
  }
  return baseUrl.replace(/^https?:\/\//, '');
}

function settings() {
  return vscode.workspace.getConfiguration('oneByok');
}

/**
 * Gather workspace context: active files, workspace folders, git info, project structure.
 * @returns {Promise<Object>} Context object with workspace metadata
 */
async function gatherWorkspaceContext() {
  const context = {
    workspaceFolders: [],
    activeFile: null,
    openFiles: [],
    gitInfo: null,
  };

  // Workspace folders
  const folders = vscode.workspace.workspaceFolders;
  if (folders?.length) {
    context.workspaceFolders = folders.map((f) => ({
      name: f.name,
      path: f.uri.fsPath,
    }));
  }

  // Active editor
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const doc = editor.document;
    const fsPath = doc.uri.fsPath;
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
    const relativePath = workspaceFolder
      ? path.relative(workspaceFolder.uri.fsPath, fsPath)
      : fsPath;
    context.activeFile = {
      path: fsPath,
      relativePath,
      language: doc.languageId,
      lineCount: doc.lineCount,
      isDirty: doc.isDirty,
    };
  }

  // Open tabs
  try {
    const openEditors = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    context.openFiles = openEditors
      .filter((t) => t.input instanceof vscode.TabInputText)
      .map((t) => {
        const uri = t.input.uri;
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        const relativePath = workspaceFolder
          ? path.relative(workspaceFolder.uri.fsPath, uri.fsPath)
          : uri.fsPath;
        return {
          path: uri.fsPath,
          relativePath,
          language: t.input?.languageId || 'unknown',
        };
      });
  } catch {
    // Tab groups API may not be available in older VS Code versions
  }

  // Git info (if available)
  try {
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    if (gitExtension?.isActive) {
      const git = gitExtension.exports.getAPI(1);
      const repo = git.repositories[0];
      if (repo) {
        const branch = repo.state.HEAD?.name || 'unknown';
        const status = repo.state.workingTreeChanges?.length ?? 0;
        const staged = repo.state.indexChanges?.length ?? 0;
        context.gitInfo = {
          branch,
          workingTreeChanges: status,
          stagedChanges: staged,
        };
      }
    }
  } catch {
    // Git extension not available
  }

  return context;
}

/**
 * Build a workspace context system prompt segment.
 * @param {Object} ctx - Workspace context from gatherWorkspaceContext()
 * @returns {string} System prompt segment
 */
function buildWorkspaceContextPrompt(ctx) {
  const lines = ['=== Workspace Context ==='];

  if (ctx.workspaceFolders?.length) {
    lines.push(`Workspace folders: ${ctx.workspaceFolders.map((f) => f.name).join(', ')}`);
    lines.push(`Root: ${ctx.workspaceFolders[0].path}`);
  }

  if (ctx.activeFile) {
    lines.push(`Active file: ${ctx.activeFile.relativePath} (${ctx.activeFile.language})`);
    lines.push(`  Lines: ${ctx.activeFile.lineCount}, Modified: ${ctx.activeFile.isDirty ? 'yes' : 'no'}`);
  }

  if (ctx.openFiles?.length) {
    const fileList = ctx.openFiles
      .map((f) => `${f.relativePath} (${f.language})`)
      .join('\n  ');
    lines.push(`Open files:\n  ${fileList}`);
  }

  if (ctx.gitInfo) {
    lines.push(`Git branch: ${ctx.gitInfo.branch}`);
    if (ctx.gitInfo.workingTreeChanges > 0 || ctx.gitInfo.stagedChanges > 0) {
      lines.push(`  Changes: ${ctx.gitInfo.workingTreeChanges} modified, ${ctx.gitInfo.stagedChanges} staged`);
    }
  }

  return lines.join('\n');
}

/**
 * Extract snippet from active editor around cursor position.
 * Useful for providing relevant code context to the model.
 * @param {number} lines - Number of lines to include
 * @returns {Promise<string>} Code snippet with context
 */
async function getActiveFileContext(lines = 10) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return '';

  const doc = editor.document;
  const cursor = editor.selection.active.line;
  const start = Math.max(0, cursor - lines);
  const end = Math.min(doc.lineCount, cursor + lines);

  const snippet = doc
    .getText(new vscode.Range(start, 0, end, 0))
    .split('\n')
    .map((line, i) => {
      const lineNum = start + i + 1;
      const marker = lineNum === cursor + 1 ? '> ' : '  ';
      return `${marker}${String(lineNum).padStart(3)} | ${line}`;
    })
    .join('\n');

  return `\n=== Active File Context ===\nFile: ${doc.uri.fsPath}\n\`\`\`${doc.languageId}\n${snippet}\n\`\`\``;
}


class OneByokProvider {
  /**
   * @param {vscode.ExtensionContext} context
   */
  constructor(context) {
    this.context = context;
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeLanguageModelChatInformation = this._emitter.event;
    /** @type {{ models: import('vscode').LanguageModelChatInformation[], ts: number } | null} */
    this._cache = null;
  }

  fireChanged() {
    this._cache = null;
    this._emitter.fire();
  }

  dispose() {
    this._emitter.dispose();
  }

  async resolveApiKey() {
    const managed = ((await this.context.secrets.get(MANAGED_SECRET_KEY)) ?? '').trim();
    if (managed) {
      return managed;
    }
    const fromSetting = String(settings().get('apiKey', '') || '').trim();
    if (fromSetting) {
      return fromSetting;
    }
    const legacy = ((await this.context.secrets.get(SECRET_KEY)) ?? '').trim();
    return legacy;
  }

  headers(apiKey, withBody) {
    // ponytail: local endpoints (Ollama etc.) often need no key — only send the
    // Authorization header when a key is actually present.
    const h = {};
    if (apiKey) {
      h.Authorization = `Bearer ${apiKey}`;
    }
    if (withBody) {
      h['Content-Type'] = 'application/json';
    }
    return h;
  }

  signal(token, timeoutMs = 0) {
    const controller = new AbortController();
    let timer;
    if (timeoutMs > 0) {
      // ponytail: single dangling setTimeout is fine; discovery calls are short-lived
      timer = setTimeout(() => controller.abort(), timeoutMs);
    }
    if (token) {
      token.onCancellationRequested(() => {
        clearTimeout(timer);
        controller.abort();
      });
    }
    return controller.signal;
  }

  /**
   * Called by VS Code whenever it builds the model picker — fetches the live catalog.
   *
   * @returns {Promise<vscode.LanguageModelChatInformation[]>}
   */
  async provideLanguageModelChatInformation(options, token) {
    // Endpoints come only from the `oneByok.endpoints` setting.
    // Legacy single-endpoint secret/storage is deliberately ignored.
    const endpoints = resolveEndpoints();
    /** @type {vscode.LanguageModelChatInformation[]} */
    const models = [];
    // Explicit "Add model" click (options.silent === false) should always offer
    // to add another endpoint, even when some already exist.
    if (!options.silent) {
      logInfo(
        `Add model clicked (${endpoints.length} endpoint(s) configured). Opening Add Endpoint form.`
      );
      void vscode.commands.executeCommand('oneByok.addEndpoint');
      // Return current models immediately; the form runs async and will fire
      // fireChanged() to refresh the picker after the user adds one.
      if (endpoints.length > 0) {
        // Continue to discover and return current models below
      } else {
        return models;
      }
    }

    // Return cached models if still fresh (30 s TTL) to avoid redundant fetches.
    if (this._cache && (Date.now() - this._cache.ts) < MODEL_CACHE_TTL_MS) {
      return this._cache.models;
    }
    const enableTools = settings().get('enableTools', true);
    const enableVision = settings().get('enableVision', true);
    const forceVision = settings().get('forceVision', false);
    const defaultMaxIn = settings().get('maxInputTokens', 262144);
    const defaultMaxOut = settings().get('maxOutputTokens', 32768);

    for (const ep of endpoints) {
      try {
        const res = await fetch(`${ep.baseUrl}/models`, {
          headers: this.headers(ep.apiKey, false),
          // ponytail: 15s cap so an unreachable baseUrl can't hang model resolution
          signal: this.signal(token, 15000),
        });
        if (!res.ok) {
          throw new Error(`/models failed: HTTP ${res.status}`);
        }
        const payload = await res.json();
        for (const m of payload.data ?? []) {
          if (!m?.id) {
            continue;
          }
          // Try to read context window from model metadata (various server conventions)
          // vLLM: context_window, Ollama: max_context_length, LM Studio: max_tokens, etc.
          const modelContextWindow =
            m.context_window ??
            m.max_context_length ??
            m.max_tokens ??
            m.n_ctx ??
            defaultMaxIn;
          // Use model's declared context window, with a safety margin for output tokens
          const maxIn = Math.min(modelContextWindow, defaultMaxIn);
          const maxOut = Math.min(defaultMaxOut, Math.floor(modelContextWindow * 0.25));
          const modelName = String(m.id);
          const displayName = endpoints.length > 1 ? `${modelName} · ${ep.name}` : modelName;
          const detailStr = ep.name
            ? `${ep.name} · context: ${maxIn.toLocaleString()} tokens`
            : `context: ${maxIn.toLocaleString()} tokens`;
          // forceVision advertises image input for every model so the picker's
          // paste/drag UI stays enabled even when the endpoint under-reports
          // capabilities (e.g. a gateway that reroutes images to a vision model).
          const supportsVision = enableVision && (forceVision || isVisionSupported(m));
          models.push({
            id: `${ep.baseUrl}|${modelName}`,
            name: displayName,
            family: VENDOR,
            version: m.created ? String(m.created) : '1',
            maxInputTokens: maxIn,
            maxOutputTokens: maxOut,
            capabilities: { toolCalling: enableTools, imageInput: supportsVision },
            isUserSelectable: true,
            detail: detailStr,
            tooltip: `${modelName} · context: ${maxIn.toLocaleString()} tokens`,
            // Ride-along credentials (same pattern as VS Code's built-in BYOK
            // providers): extra properties survive the extension-host round trip
            // and come back on `model` in provideLanguageModelChatResponse.
            baseUrl: ep.baseUrl,
            apiKey: ep.apiKey,
            // Original model id used in the chat/completions request body
            modelId: modelName,
            // Store model's declared context window for dynamic workspace context sizing
            contextWindow: modelContextWindow,
          });
        }
        logInfo(
          `Discovered ${payload.data?.length ?? 0} model(s) from ${ep.baseUrl}/models (${ep.source})`
        );
      } catch (err) {
        const cause = describeErrorCause(err);
        logWarn(
          `Model discovery failed from ${ep.baseUrl}/models: ${err?.message ?? err}${cause ? ` (cause: ${cause})` : ''}`
        );
      }
    }
    this._cache = { models, ts: Date.now() };
    return models;
  }

  /**
   * Streams a chat completion and reports text/tool-call parts as they arrive.
   * Injects workspace context into the request when enabled.
   *
   * Resilience layers, in order:
   *   1. Retry the SAME model for transient failures (`oneByok.maxRetries`).
   *   2. Fail over to the next entry of `oneByok.fallbackModels`.
   * Both are only allowed before the first byte reaches the chat — see
   * `throwWithStreaming`.
   */
  async provideLanguageModelChatResponse(model, messages, options, progress, token) {
    // Fallback is opt-in: with an empty list the loop runs once and the
    // original single-attempt behaviour is preserved exactly.
    const primary = await this.describeTarget(model);
    const candidates = [primary];
    for (const fb of this.resolveFallbackTargets(primary.baseUrl)) {
      // Never retry the model the user actually picked.
      if (!candidates.some((c) => c.baseUrl === fb.baseUrl && c.modelId === fb.modelId)) {
        candidates.push(fb);
      }
    }
    const maxRetries = Math.max(0, Math.min(5, Number(settings().get('maxRetries', 2)) || 0));

    const seenTargets = [];
    /** Endpoints whose credentials were rejected; another model there cannot help. */
    const rejectedEndpoints = new Set();
    /** @type {unknown} */
    let lastError;

    for (let idx = 0; idx < candidates.length; idx++) {
      const target = candidates[idx];
      const isPrimary = idx === 0;

      if (rejectedEndpoints.has(target.baseUrl)) {
        logWarn(
          `Skipping fallback "${target.modelId}" — the credentials for ${target.baseUrl} were already rejected.`
        );
        continue;
      }
      if (!isPrimary) {
        logWarn(`Falling back from "${primary.modelId}" to "${target.modelId}" @ ${target.baseUrl}.`);
      }

      seenTargets.push(`${target.modelId} @ ${target.baseUrl}`);
      // Retries apply to the model the user picked. A fallback model is already
      // the second chance, so it gets a single shot.
      const attempts = 1 + (isPrimary ? maxRetries : 0);

      for (let attempt = 0; attempt < attempts; attempt++) {
        const result = await this._runFinishAttempt(target, messages, options, progress, token);

        if (result.ok) {
          if (!isPrimary) {
            logWarn(`Answered by fallback model "${target.modelId}" after "${primary.modelId}" failed.`);
            // Silent substitution would be surprising: the user chose a model
            // and got another one, so say so.
            void vscode.window.showWarningMessage(
              `One-BYOK: "${primary.modelId}" failed — the request was answered by the fallback model "${target.modelId}".`
            );
          } else if (attempt > 0) {
            logInfo(`Recovered after ${attempt} retry(ies) with "${target.modelId}".`);
          }
          return;
        }

        lastError = result.err;
        const failure = classifyError(lastError);
        logError(`Attempt ${attempt + 1}/${attempts} for "${target.modelId}" failed [${failure.kind}]`, lastError);

        if (failure.kind === 'streaming') {
          // Output already reached the chat: repeating it would duplicate text
          // and the user is already reading half an answer.
          throw new Error(
            `One-BYOK: ${failure.detail} — output had already started streaming, so the request cannot be retried or replaced by a fallback model.`
          );
        }
        // A user-initiated stop is deliberate, not a failure to work around.
        if (token?.isCancellationRequested) {
          throw new Error('One-BYOK: Request cancelled.');
        }
        if (failure.kind === 'auth') {
          // The key is wrong, not the model: every other model on this host
          // would fail identically, so rule the whole endpoint out.
          rejectedEndpoints.add(target.baseUrl);
          logWarn(`HTTP ${failure.status} from ${target.baseUrl} — skipping its remaining fallback models.`);
          break;
        }
        // A bad request (unknown model, unsupported parameter) is worth trying
        // on another model, so fall through to the next candidate.
        if (!failure.retryable) {
          break;
        }
        if (attempt < attempts - 1) {
          const delay = retryDelayMs(attempt);
          logInfo(`Retrying "${target.modelId}" in ${delay}ms (attempt ${attempt + 2}/${attempts}).`);
          await sleep(delay);
          continue;
        }
        if (failure.kind === 'server' && failure.status === 429) {
          // The whole upstream is throttling; give it a moment before a
          // fallback model hammers the same host.
          await sleep(1000);
        }
      }
    }

    // Every candidate failed — surface the reason from the model the user chose.
    const finalFailure = classifyError(lastError);
    logError(`All candidate model(s) failed (${seenTargets.length} tried): ${seenTargets.join(' → ')}`);
    if (seenTargets.length === 1) {
      throw new Error(`One-BYOK: ${finalFailure.detail}`);
    }
    throw new Error(
      `One-BYOK: "${primary.modelId}" failed (${finalFailure.detail}) — ${seenTargets.length - 1} fallback model(s) also failed.`
    );
  }

  /**
   * One streaming attempt against a single target.
   *
   * Never throws: the caller decides whether to retry or fail over, which it can
   * only do once it knows how far the attempt got.
   *
   * @returns {Promise<{ ok: true } | { ok: false, err: unknown }>}
   */
  async _runFinishAttempt(target, messages, options, progress, token) {
    try {
      await this._doChatResponse(target, messages, options, progress, token);
      return { ok: true };
    } catch (err) {
      return { ok: false, err };
    }
  }

  /**
   * Turn the selected model (or the configured base URL as a last resort) into
   * a concrete request target.
   *
   * @param {any} model
   * @returns {Promise<{ baseUrl: string, apiKey: string, modelId: string, contextWindow: number|undefined }>}
   */
  async describeTarget(model) {
    let baseUrl = trimUrl(model?.baseUrl);
    let apiKey = String(model?.apiKey ?? '').trim();
    if (!baseUrl) {
      baseUrl = (await resolveBaseUrl(this.context)).url;
    }
    if (!apiKey) {
      apiKey = await this.resolveApiKey();
    }
    if (!baseUrl) {
      throw new Error('One-BYOK is not configured (missing base URL).');
    }
    return {
      baseUrl,
      apiKey,
      modelId: String(model?.modelId ?? model?.id ?? ''),
      contextWindow: Number(model?.contextWindow) || undefined,
    };
  }

  /**
   * Resolve `oneByok.fallbackModels` (a list of model ids) against the
   * configured endpoints, so each entry inherits that endpoint's credentials.
   *
   * An entry may be written as `modelId` or `modelId @ <endpoint host/name>`
   * to disambiguate when several endpoints expose the same model id. Unknown
   * ids are skipped with a warning rather than failing the fallback chain.
   *
   * @param {string} primaryBaseUrl - Endpoint of the user's chosen model, used
   *   as the default home for bare model ids when several endpoints exist.
   * @returns {{ baseUrl: string, apiKey: string, modelId: string }[]}
   */
  resolveFallbackTargets(primaryBaseUrl) {
    const configured = settings().get('fallbackModels', []);
    if (!Array.isArray(configured)) {
      return [];
    }
    const endpoints = resolveEndpoints();
    const out = [];
    for (const raw of configured) {
      const entry = String(raw ?? '').trim();
      if (!entry) {
        continue;
      }
      const at = entry.lastIndexOf('@');
      const modelId = at > 0 ? entry.slice(0, at).trim() : entry;
      const hint = at > 0 ? entry.slice(at + 1).trim().toLowerCase() : '';
      let match;
      if (hint) {
        match = endpoints.find((ep) => {
          return (
            endpointName(ep.name, ep.baseUrl).toLowerCase() === hint ||
            ep.baseUrl.toLowerCase() === hint ||
            ep.baseUrl.toLowerCase().includes(hint)
          );
        });
      } else {
        // A bare model id belongs to whichever endpoint already serves the
        // chosen model; with a single endpoint that is always the right answer.
        match = endpoints.find((ep) => ep.baseUrl === primaryBaseUrl)
          ?? (endpoints.length === 1 ? endpoints[0] : undefined);
      }
      if (!match) {
        logWarn(
          `Fallback model "${entry}" could not be matched to a configured endpoint — skipping it.`
        );
        continue;
      }
      out.push({ baseUrl: match.baseUrl, apiKey: match.apiKey, modelId });
    }
    return out;
  }

  /**
   * Perform one streaming request against `target` and report parts as they
   * arrive.
   *
   * @param {{ baseUrl: string, apiKey: string, modelId: string, contextWindow: number|undefined }} target
   * @returns {Promise<void>}
   */
  async _doChatResponse(target, messages, options, progress, token) {
    const base = target.baseUrl;
    const apiKey = target.apiKey;

    // Gather and optionally inject workspace context.
    // Dynamically size workspace context based on model's declared context window.
    // Reserve ~75% for conversation history + system prompt + tool schemas,
    // use up to 25% for workspace context (with a configurable cap).
    const injectContext = settings().get('injectWorkspaceContext', false);
    const maxContextCharsSetting = settings().get('maxWorkspaceContextChars', 500);
    // Model's declared context window (from /v1/models metadata), fallback to setting
    const modelContextWindow = target.contextWindow ?? settings().get('maxInputTokens', 262144);
    // Heuristic: ~4 chars per token, reserve 75% for conversation, use up to 25% for workspace
    const dynamicMaxContextChars = Math.floor((modelContextWindow * 0.25) * 4);
    const maxContextChars = Math.min(maxContextCharsSetting, dynamicMaxContextChars);
    let workspaceContextStr = '';
    if (injectContext) {
      try {
        const wsCtx = await gatherWorkspaceContext();
        workspaceContextStr = buildWorkspaceContextPrompt(wsCtx);
        logDebug(`Workspace context collected: ${wsCtx.workspaceFolders.length} folders, ${wsCtx.openFiles.length} open files`);
        logDebug(`Model context window: ${modelContextWindow.toLocaleString()} tokens, workspace context budget: ${maxContextChars} chars`);
        if (workspaceContextStr.length > maxContextChars) {
          workspaceContextStr = workspaceContextStr.slice(0, maxContextChars) + '\n…(truncated)';
          logDebug(`Workspace context truncated to ${maxContextChars} chars (${Math.floor(maxContextChars/4).toLocaleString()} tokens)`);
        }
      } catch (ctxErr) {
        // Degradation, not fatal: the request continues without workspace context.
        logWarn(`Workspace context gathering failed (continuing without): ${ctxErr?.message ?? ctxErr}`);
      }
    }

    // Build messages with workspace context injected into the first system/user message
    let messagesForModel = toOpenAiMessages(messages);
    if (workspaceContextStr) {
      const hasSystemMsg = messagesForModel.length > 0 && messagesForModel[0].role === 'system';
      if (hasSystemMsg) {
        if (typeof messagesForModel[0].content === 'string') {
          messagesForModel[0].content = (messagesForModel[0].content || '') + '\n\n' + workspaceContextStr;
        } else if (Array.isArray(messagesForModel[0].content)) {
          messagesForModel[0].content.push({ type: 'text', text: workspaceContextStr });
        }
      } else {
        messagesForModel.unshift({
          role: 'system',
          content: workspaceContextStr,
        });
      }
    }

    const body = {
      model: target.modelId,
      messages: messagesForModel,
      stream: true,
    };
    const opts = options.modelOptions ?? {};
    if (typeof opts.temperature === 'number') {
      body.temperature = opts.temperature;
    }
    if (opts.maxTokens) {
      body.max_tokens = opts.maxTokens;
    }
    const enableTools = settings().get('enableTools', true);
    // Only inspect the last (newest) message for images — checking the whole
    // history would suppress tools forever after the first image appeared.
    const lastMsg = messagesForModel[messagesForModel.length - 1];
    const hasImageContent = Array.isArray(lastMsg?.content)
      && lastMsg.content.some((p) => p.type === 'image_url');
    if (enableTools && options.tools?.length && !hasImageContent) {
      body.tools = options.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description ?? '',
          parameters: t.inputSchema ?? { type: 'object' },
        },
      }));
      if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
        body.tool_choice = 'required';
      }
      logDebug(`Tools available: ${options.tools.map((t) => t.name).join(', ')}`);
    } else if (hasImageContent) {
      logDebug('Tools omitted: request contains image content (some endpoints reject tools + image_url)');
    }

    const requestTimeoutMs = settings().get('requestTimeoutMs', 300_000);
    logDebug(`Request timeout: ${requestTimeoutMs}ms`);
    logDebug(`Request body: ${JSON.stringify(body).slice(0, 500)}`);
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: this.headers(apiKey, true),
      body: JSON.stringify(body),
      signal: this.signal(token, requestTimeoutMs),
    });
    logDebug(`HTTP response: ${res.status} ${res.statusText}`);
    if (!res.ok) {
      throw await this.httpError(res);
    }

    /** @type {Map<number, { id: string, name: string, args: string }>} */
    const toolAcc = new Map();
    let textContent = '';
    // Set before reporting anything: the orchestration layer needs to know that
    // the reply is no longer replaceable once output has been shown.
    let started = false;
    // Clear any body captured by a previous request, so a diagnostic message can
    // never quote the response of an unrelated call.
    sseData.lastBody = '';
    try {
      for await (const data of sseData(res.body)) {
        // Verbose: raw SSE payloads are large and contain prompt/response content.
        logDebug(`SSE data: ${data.length > 200 ? data.slice(0, 200) + '...' : data}`);
        if (data === '[DONE]') {
          break;
        }
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        // Some gateways answer 200 and then report the failure in the stream
        // (vLLM, LiteLLM, OpenRouter). Ignoring it made the request look like it
        // succeeded with an empty reply, which is impossible to diagnose.
        if (json.error) {
          const detail = errorMessageFromBody(json.error) || 'the endpoint reported an error';
          throw throwWithStreaming(new Error(detail), started);
        }
        const delta = json.choices?.[0]?.delta ?? {};
        if (delta.content) {
          started = true;
          textContent += delta.content;
          progress.report(new vscode.LanguageModelTextPart(delta.content));
        }
        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const acc = toolAcc.get(idx) ?? { id: '', name: '', args: '' };
          if (tc.id) {
            acc.id = tc.id;
          }
          if (tc.function?.name) {
            acc.name += tc.function.name;
          }
          if (tc.function?.arguments) {
            acc.args += tc.function.arguments;
          }
          toolAcc.set(idx, acc);
        }
      }
    } catch (err) {
      throw throwWithStreaming(err, started);
    }

    // A non-SSE body (a plain JSON error, or `{choices:[...]}` from a server
    // that ignores stream:true) yields no parts at all. Silently returning
    // nothing is what produced the useless "Sorry, no response was returned.",
    // so report whatever the server actually said.
    if (!started && toolAcc.size === 0) {
      const raw = sseData.lastBody;
      const detail = errorMessageFromBody(raw) || raw;
      logDebug(`No streamed content. Raw body: ${raw.slice(0, 300) || '(empty)'}`);
      throw new Error(
        'the endpoint returned HTTP 200 but no streamed content' +
          (detail ? ` — it sent: ${detail.slice(0, 200)}` : '')
      );
    }

    // Log tool calls for debugging/tracing and validate args
    if (toolAcc.size > 0) {
      for (const [idx, acc] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
        if (acc.name) {
          logDebug(`Tool call ${idx}: ${acc.name}(${acc.args.length > 100 ? acc.args.slice(0, 100) + '...' : acc.args})`);
          // Parse arguments into an object — LanguageModelToolCallPart requires
          // an object, not a JSON string.  VS Code rejects strings with
          // "must be object".
          let argsObj;
          try {
            const parsed = JSON.parse(acc.args || '{}');
            if (typeof parsed === 'string') {
              // Model emitted a bare string (e.g. "/path/to/file") instead of
              // an object. Wrap it so VS Code accepts the tool call.
              logDebug(`Tool call ${idx}: args was a bare string, wrapping as object`);
              argsObj = { path: parsed };
            } else if (typeof parsed !== 'object' || parsed === null) {
              logDebug(`Tool call ${idx}: args was a non-object primitive, wrapping`);
              argsObj = { value: parsed };
            } else {
              argsObj = parsed;
            }
          } catch {
            // Unparseable JSON — emit a descriptive tool result so the model
            // knows what went wrong instead of VS Code silently rejecting it.
            logDebug(`Tool call ${idx}: unparseable args, emitting error result`);
            const callId = acc.id || randomId();
            progress.report(
              new vscode.LanguageModelToolCallPart(callId, acc.name, {}),
            );
            progress.report(
              new vscode.LanguageModelToolResultPart(
                callId,
                `Error: Invalid JSON arguments supplied. The raw arguments were: ${acc.args.slice(0, 500)}`,
              ),
            );
            continue;
          }
          progress.report(new vscode.LanguageModelToolCallPart(acc.id || randomId(), acc.name, argsObj));
        }
      }
    }

    // Log text response summary
    if (textContent) {
      logDebug(`Response: ${textContent.length} characters`);
    }
  }

  /**
   * Read an error response body and turn it into an HttpError carrying the
   * server's own message.
   *
   * @param {Response} res
   * @returns {Promise<HttpError>}
   */
  async httpError(res) {
    const raw = (await res.text().catch(() => '')).slice(0, 1000);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
    const detail = errorMessageFromBody(parsed);
    logDebug(`Error response body: ${raw.slice(0, 300)}`);
    return new HttpError(
      res.status,
      `chat/completions failed: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`,
      raw
    );
  }

  /**
   * Cheap heuristic token count (~4 chars per token).
   */
  async provideTokenCount(_model, text, _token) {
    let value = '';
    if (typeof text === 'string') {
      value = text;
    } else if (Array.isArray(text)) {
      value = text
        .map((p) => (typeof p === 'string' ? p : p?.value ?? JSON.stringify(p) ?? ''))
        .join('');
    } else if (text && typeof text === 'object') {
      value = String(text.value ?? JSON.stringify(text));
    }
    return Math.ceil(value.length / 4);
  }
}

function randomId() {
  return `call_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * VS Code roles are numeric (User=1, Assistant=2, System=3 [proposed]); OpenAI wants strings.
 */
function toOpenAiRole(role) {
  switch (role) {
    case 2:
    case 'assistant':
      return 'assistant';
    case 3:
    case 'system':
    case 'developer':
      return 'system';
    case 1:
    case 'user':
    default:
      return 'user';
  }
}

function partValue(part) {
  return typeof part === 'string' ? part : part?.value;
}

function isToolUsePart(part) {
  return part && typeof part === 'object' && 'callId' in part && 'name' in part && 'input' in part;
}

function isToolResultPart(part) {
  return part && typeof part === 'object' && 'callId' in part && 'content' in part && !('name' in part);
}

/**
 * Detect whether a model supports vision / image inputs based on server metadata or model id patterns.
 * @param {object} m - Model object from /v1/models response
 * @returns {boolean}
 */
function isVisionSupported(m) {
  if (m?.capabilities?.vision !== undefined) {
    return Boolean(m.capabilities.vision);
  }
  if (m?.capabilities?.imageInput !== undefined) {
    return Boolean(m.capabilities.imageInput);
  }
  const id = String(m?.id ?? '');
  return /vision|image|-vl\b|_vl\b|pixtral|llava|gemini|claude-3|claude-4|claude-sonnet|claude-opus|claude-haiku|claude-fable|gpt-4o|gpt-4-turbo|gpt-4-vision|\bo1|\bo3/i.test(id);
}

function isImagePart(part) {
  if (!part || typeof part !== 'object') {
    return false;
  }
  if (typeof part.mimeType === 'string' && part.mimeType.startsWith('image/')) {
    return true;
  }
  if (part.type === 'image_url' || part.type === 'image') {
    return true;
  }
  return false;
}

/**
 * Normalize the many shapes image bytes arrive in (Buffer, Uint8Array,
 * ArrayBuffer, number[], or a VSBuffer-like `{ buffer, byteOffset, byteLength }`)
 * into a plain Uint8Array view. Prefer the view over its raw `.buffer`: VS Code
 * hands out Uint8Arrays that can be windows into a shared pool, so reading
 * `.buffer` alone would drag in unrelated bytes and corrupt the image.
 */
function toUint8Array(value) {
  if (!value) {
    return undefined;
  }
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (Array.isArray(value)) {
    return Uint8Array.from(value);
  }
  if (typeof value === 'object') {
    if (value.buffer instanceof ArrayBuffer) {
      // VSBuffer-like: keep the byteOffset/byteLength window intact.
      return new Uint8Array(value.buffer, value.byteOffset ?? 0, value.byteLength);
    }
    // Serialized-as-object fallback: `{ "0": 137, "1": 80, ... }`.
    const values = Object.values(value);
    if (values.length > 0 && values.every((v) => typeof v === 'number')) {
      return Uint8Array.from(values);
    }
  }
  return undefined;
}

function toOpenAiImageContent(part) {
  const mimeType = part.mimeType || 'image/png';
  const bytes = toUint8Array(part.data) ?? toUint8Array(part.value?.data);
  if (bytes && bytes.byteLength > 0) {
    const base64 = Buffer.from(bytes).toString('base64');
    logDebug(`Image part: mimeType=${mimeType}, bytes=${bytes.byteLength}, base64=${base64.length}`);
    return {
      type: 'image_url',
      image_url: {
        url: `data:${mimeType};base64,${base64}`,
      },
    };
  }
  const url = part.url || part.value?.url || part.image_url?.url;
  if (typeof url === 'string') {
    logDebug(`Image part: using URL ${url.slice(0, 60)}…`);
    return {
      type: 'image_url',
      image_url: {
        url,
      },
    };
  }
  logWarn(`Image part skipped: no decodable bytes or url (keys: ${Object.keys(part).join(',')})`);
  return null;
}

/**
 * Translate VS Code language-model messages into OpenAI chat-completions format.
 * Text parts are joined; tool use/result parts are mapped to tool_calls / role:"tool".
 * Image parts are converted to OpenAI vision image_url objects.
 * Logs tool results for debugging multi-turn flows.
 */
function toOpenAiMessages(messages) {
  /** @type {object[]} */
  const out = [];
  for (const msg of messages ?? []) {
    const raw = msg.content;
    let parts;
    if (Array.isArray(raw)) {
      parts = raw;
    } else if (raw === undefined || raw === null) {
      parts = [];
    } else {
      parts = [raw];
    }
    const texts = [];
    const toolUses = [];
    const toolResults = [];
    const imageParts = [];
    for (const part of parts) {
      if (isToolUsePart(part)) {
        toolUses.push(part);
      } else if (isToolResultPart(part)) {
        toolResults.push(part);
      } else if (isImagePart(part)) {
        const img = toOpenAiImageContent(part);
        if (img) {
          imageParts.push(img);
        }
      } else {
        // Surface unrecognised binary/mime parts once so image payloads VS Code
        // sends under a different shape are visible in the output channel.
        if (part && typeof part === 'object' && ('mimeType' in part || 'data' in part)) {
          logWarn(`Unrecognised binary part (keys: ${Object.keys(part).join(',')}, mimeType: ${part.mimeType ?? 'n/a'}, ctor: ${part.constructor?.name ?? 'n/a'})`);
        }
        texts.push(String(partValue(part) ?? JSON.stringify(part ?? '')));
      }
    }
    if (toolUses.length) {
      // Assistant message may carry both tool calls and image parts.
      const content = [];
      const textContent = texts.join('');
      if (textContent) content.push({ type: 'text', text: textContent });
      content.push(...imageParts);
      out.push({
        role: 'assistant',
        content: content.length ? content : null,
        tool_calls: toolUses.map((tc) => ({
          id: tc.callId ?? tc.name,
          type: 'function',
          function: {
            name: tc.name,
            arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input ?? {}),
          },
        })),
      });
      continue;
    }
    if (toolResults.length) {
      for (const tr of toolResults) {
        const trRaw = tr.content;
        let trParts;
        if (Array.isArray(trRaw)) {
          trParts = trRaw;
        } else if (trRaw === undefined || trRaw === null) {
          trParts = [];
        } else {
          trParts = [trRaw];
        }
        const content = trParts
          .map((p) => String(partValue(p) ?? JSON.stringify(p ?? '')))
          .join('');
        // Log tool results for transparency in multi-turn flows
        const resultPreview = content.length > 150 ? content.slice(0, 150) + '...' : content;
        const singleLine = resultPreview.replaceAll('\n', ' ');
        logDebug(`Tool result: ${tr.callId} → ${singleLine}`);
        out.push({ role: 'tool', tool_call_id: tr.callId, content });
      }
      if (texts.length || imageParts.length) {
        const role = toOpenAiRole(msg.role);
        if (imageParts.length) {
          const content = [];
          const textContent = texts.join('');
          if (textContent) {
            content.push({ type: 'text', text: textContent });
          }
          content.push(...imageParts);
          out.push({ role, content });
        } else {
          out.push({ role, content: texts.join('') });
        }
      }
      continue;
    }
    const role = toOpenAiRole(msg.role);
    if (imageParts.length) {
      const content = [];
      const textContent = texts.join('');
      if (textContent) {
        content.push({ type: 'text', text: textContent });
      }
      content.push(...imageParts);
      out.push({ role, content });
    } else {
      out.push({ role, content: texts.join('') });
    }
  }
  return out;
}

/**
 * Parse an SSE byte stream and yield the payload of each `data:` line.
 *
 * A server that answers `200` with a plain JSON body instead of an SSE stream
 * emits no `data:` line at all. That body is the only clue about what went
 * wrong, so it is captured on the returned generator's `nonSseBody` property
 * rather than being discarded — otherwise a misconfigured gateway looks like an
 * empty-but-successful reply.
 *
 * @param {AsyncIterable<Uint8Array>} body
 */
async function* sseData(body) {
  const decoder = new TextDecoder();
  const nonSse = [];
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trimEnd();
      buffer = buffer.slice(idx + 1);
      if (line.startsWith('data:')) {
        yield line.slice(5).trim();
      } else if (line && !line.startsWith(':') && !line.startsWith('event:')) {
        // Some gateways prefix the payload (e.g. "data-json: {...}").
        const json = line.indexOf('{');
        nonSse.push(json >= 0 ? line.slice(json) : line);
      }
    }
  }
  // Flush remaining buffer — some servers omit the trailing newline on the
  // last data line, which would otherwise be silently dropped.
  const tail = buffer.trim();
  if (tail.startsWith('data:')) {
    yield tail.slice(5).trim();
  } else if (tail && !tail.startsWith(':') && !tail.startsWith('event:')) {
    const json = tail.indexOf('{');
    nonSse.push(json >= 0 ? tail.slice(json) : tail);
  }
  sseData.lastBody = nonSse.join('\n').slice(0, 500);
}
/** Raw non-SSE body from the most recent sseData() call (diagnostics only). */
sseData.lastBody = '';

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  channel = vscode.window.createOutputChannel('One-BYOK', { log: true });
  context.subscriptions.push(channel);
  applyDebugLoggingSetting(false);

  const provider = new OneByokProvider(context);
  context.subscriptions.push(provider);

  // Register the language-model provider (requires VS Code ≥ 1.102).
  // Wrap defensively: if lm API is unavailable, commands still register.
  try {
    context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(VENDOR, provider));
  } catch (err) {
    logError('Failed to register language model provider (lm API may not be available)', err);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('oneByok.setApiKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: `API key for the "${VENDOR}" model provider`,
        password: true,
        ignoreFocusOut: true,
      });
      if (key === undefined) {
        return;
      }
      const trimmed = key.trim();
      if (!trimmed) {
        logInfo('Set API Key cancelled: input was empty; nothing stored.');
        void vscode.window.showWarningMessage('One-BYOK: empty key — nothing stored.');
        return;
      }
      await context.secrets.store(MANAGED_SECRET_KEY, trimmed);
      const readBack = await context.secrets.get(MANAGED_SECRET_KEY);
      const readStatus = readBack?.length ? `ok len=${readBack.length}` : 'FAILED';
      if (readBack?.length) {
        logInfo(`API key stored (read-back: ${readStatus}).`);
      } else {
        // Storing appeared to succeed but the value cannot be read back.
        logWarn(`API key stored but read-back ${readStatus}.`);
      }
      provider.fireChanged();
      void vscode.window.showInformationMessage('One-BYOK: API key stored. Model list will refresh automatically.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('oneByok.addEndpoint', async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'Name for this endpoint (e.g. "My Ollama")',
        ignoreFocusOut: true,
      });
      if (name === undefined) {
        return;
      }
      const label = name.trim();
      const baseUrl = await vscode.window.showInputBox({
        prompt: 'Base URL of the OpenAI-compatible endpoint (e.g. http://localhost:11434/v1)',
        ignoreFocusOut: true,
      });
      if (baseUrl === undefined) {
        return;
      }
      const url = trimUrl(baseUrl);
      if (!url) {
        void vscode.window.showWarningMessage('One-BYOK: empty base URL — nothing added.');
        return;
      }
      const apiKey = await vscode.window.showInputBox({
        prompt: `API key for ${url} (leave empty for local endpoints)`,
        password: true,
        ignoreFocusOut: true,
      });
      if (apiKey === undefined) {
        return;
      }
      const endpoints = Array.isArray(settings().get('endpoints', [])) ? settings().get('endpoints', []) : [];
      if (endpoints.some((e) => trimUrl(e?.baseUrl) === url)) {
        void vscode.window.showWarningMessage('One-BYOK: that endpoint is already configured.');
        return;
      }
      const entry = { baseUrl: url, apiKey: apiKey.trim() };
      if (label) {
        // ponytail: optional label; unnamed endpoints fall back to the host
        entry.name = label;
      }
      try {
        await settings().update('endpoints', [...endpoints, entry], vscode.ConfigurationTarget.Global);
      } catch (err) {
        // ponytail: surface a silent write failure instead of losing the endpoint
        void vscode.window.showErrorMessage(`One-BYOK: failed to save endpoint (${String(err?.message ?? err)}).`);
        return;
      }
      provider.fireChanged();
      void vscode.window.showInformationMessage('One-BYOK: endpoint added. Model list will refresh automatically.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('oneByok.removeEndpoint', async () => {
      const endpoints = Array.isArray(settings().get('endpoints', [])) ? settings().get('endpoints', []) : [];
      const picks = await vscode.window.showQuickPick(
        endpoints.map((e, i) => ({ label: endpointName(e?.name, e?.baseUrl), description: e?.apiKey ? 'key set' : 'no key', index: i })),
        { placeHolder: 'Select an endpoint to remove' }
      );
      if (!picks) {
        return;
      }
      await settings().update('endpoints', endpoints.filter((_, i) => i !== picks.index), vscode.ConfigurationTarget.Global);
      provider.fireChanged();
      void vscode.window.showInformationMessage('One-BYOK: endpoint removed. Model list will refresh automatically.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('oneByok.clearApiKey', async () => {
      await context.secrets.delete(MANAGED_SECRET_KEY);
      await context.secrets.delete(SECRET_KEY);
      provider.fireChanged();
      logInfo('API key cleared (managed + legacy).');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('oneByok.refreshModels', () => {
      provider.fireChanged();
      logInfo('Manual refresh requested.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('oneByok.showWorkspaceContext', async () => {
      const wsCtx = await gatherWorkspaceContext();
      const contextStr = buildWorkspaceContextPrompt(wsCtx);
      logInfo('=== Workspace Context Snapshot ===');
      logInfo(contextStr);
      await vscode.window.showInformationMessage(
        `Workspace context gathered: ${wsCtx.openFiles.length} open files, ${wsCtx.workspaceFolders.length} folders. Check One-BYOK output channel for details.`
      );
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('oneByok')) {
        applyDebugLoggingSetting(true);
        provider.fireChanged();
      }
    })
  );

  // Refresh the model list as soon as a key is stored via the native Add-model UI.
  context.subscriptions.push(
    context.secrets.onDidChange((e) => {
        if (e.key === MANAGED_SECRET_KEY || e.key === SECRET_KEY || e.key === `${VENDOR}.baseUrl`) {
        logInfo(`Secret changed: ${e.key} — refreshing model list.`);
        provider.fireChanged();
      }
    })
  );

  logInfo('One-BYOK provider activated.');
}

function deactivate() {
  // Cleanup handled by VS Code's subscription management
}

module.exports = { activate, deactivate };
