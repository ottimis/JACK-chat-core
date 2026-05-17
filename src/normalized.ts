// Mirror of jack/src/main/providers/messages.ts (Phase-1 contract).
// Kept in sync manually until @jack/provider-sdk lands as a dedicated package.
// When you change this file, update the canonical copy in Jack's main process
// and run the parity test in jack/tests/unit/normalize.test.ts.
//
// TODO(normalized-followup): Claude's `system/status:compacting` is not yet
// distinguished by the normalized contract — it falls into `session_state`
// with `state: 'running'`, so the legacy `'Compacting'` status label is
// stale until a dedicated kind (e.g. `session_state.state === 'compacting'`
// or a new `compacting` kind) lands across providers.
// TODO(normalized-followup): the streaming token firehose still ships
// Claude `stream_event` payloads inside `partial_event.raw`. A
// `NormalizedPartialBlockEvent` shape will replace it once a second
// provider drives the design (Codex first).

/**
 * Provider-neutral message types — the contract the host (manager.ts +
 * renderer) consumes regardless of which AI provider produced the stream.
 *
 * Phase-1.5 boundary: today these are populated from Claude's `SDKMessage`
 * via Jack's `providers/claude/normalize.ts`. When `jack-codex` arrives, it
 * will populate the same shape from Codex's Responses-API stream events
 * — and the host won't have to learn a second wire format.
 *
 * Field philosophy:
 *   - Top-level fields are the canonical normalized data the host actually
 *     keys off (e.g. `kind`, `state`, `success`).
 *   - `raw` is always present. It carries the provider's original payload
 *     verbatim — useful when a consumer (analytics, debug, advanced UI)
 *     needs full fidelity. Don't depend on `raw` shape across providers.
 *
 * Adding a new `kind` is a contract change: every provider must produce it
 * and every consumer must handle it (or fall through to the existing
 * `unknown` branch). When in doubt, lean toward `unknown` + raw and only
 * promote to a first-class kind when at least two providers emit it.
 */

// ─── Tool shape ──────────────────────────────────────────────────────────

/**
 * Local mirror of `JackProvider.toolCatalog`'s shape union. Kept as a
 * string-literal union so chat-core does not pull in the `JackProvider`
 * interface from the host — providers are an implementation detail of the
 * Jack main process, this package only consumes the normalized payload.
 *
 * Keep in sync with `jack/src/main/providers/types.ts`.
 */
export type ToolShape =
  | 'fs.read'
  | 'fs.write'
  | 'fs.edit'
  | 'fs.delete'
  | 'fs.move'
  | 'fs.list'
  | 'fs.search'
  | 'shell'
  | 'web.fetch'
  | 'web.search'
  | 'todo'
  | 'plan'
  | 'ask'
  | 'topic'
  | 'subagent'
  | 'notebook.edit'
  | 'mcp'
  | 'unknown'

// ─── Tool reference ──────────────────────────────────────────────────────

/**
 * A tool name resolved against the active provider's catalog. The
 * renderer keys off `kind` + `shape` for UI selection; the host keys off
 * `raw` when echoing back to the provider (canUseTool ack, hook callback
 * response). Don't synthesize `raw` — always use what the provider
 * emitted on the wire.
 */
export type NormalizedToolRef =
  | {
      kind: 'native'
      /** Display name (== raw for Claude — `Read`, `Bash`, …). */
      toolName: string
      /** Canonical shape declared in `JackProvider.toolCatalog`. */
      shape: ToolShape
      /** Wire name as emitted by the provider. Echo this back unchanged. */
      raw: string
    }
  | {
      kind: 'mcp'
      /** MCP server slug (the registry key). */
      serverSlug: string
      /** Tool name local to that server (without provider prefix). */
      toolName: string
      /** Wire name as emitted by the provider — Claude: `mcp__<slug>__<tool>`. */
      raw: string
    }

// ─── Block-level content ─────────────────────────────────────────────────

/**
 * A single content block inside an assistant or user message. Mirrors the
 * Anthropic Messages API content shape but provider-neutral: `tool_use`
 * carries a parsed {@link NormalizedToolRef} so the renderer doesn't have
 * to know the provider's prefix conventions.
 */
export type NormalizedBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | {
      type: 'tool_use'
      toolUseId: string
      toolRef: NormalizedToolRef
      input: unknown
    }
  | {
      type: 'tool_result'
      toolUseId: string
      isError: boolean
      content: unknown
    }
  | { type: 'image'; mediaType: string; data: string }
  | { type: 'unknown'; raw: unknown }

// ─── Token usage ─────────────────────────────────────────────────────────

export type TokenUsage = {
  inputTokens?: number
  outputTokens?: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
  /**
   * Reasoning / "thoughts" tokens consumed but not surfaced as visible
   * output (Codex `reasoning_output_tokens`, Gemini `tokens.thoughts`).
   * Distinct from `outputTokens` so renderers can show "thinking cost"
   * separately when a provider exposes it.
   */
  reasoningTokens?: number
}

// ─── Message kinds ───────────────────────────────────────────────────────

/**
 * Discriminated union the host consumes. Adding a `kind` requires updates
 * in every provider's translator and at least one consumer.
 */
export type NormalizedMessage =
  /** Spawn-time announcement — provider-assigned session id, model, cwd. */
  | {
      kind: 'session_init'
      /** Provider-assigned id used to resume the conversation later. */
      sessionId: string
      model?: string
      cwd?: string
      /** Tools the provider booted with (when surfaced). */
      tools?: string[]
      /**
       * Stable per-message id when the source carries one (e.g. Claude
       * JSONL `uuid`, Codex `item.id`). Used by the indexer for FTS
       * dedup. Absent on live streams that don't surface message ids.
       */
      messageId?: string
      raw: unknown
    }
  /** Live status hint — `running` while a turn is being produced. */
  | {
      kind: 'session_state'
      state: 'idle' | 'running' | 'requires_action'
      raw: unknown
    }
  /** Provider-emitted rate limit signal (Claude `rate_limit_event`). */
  | {
      kind: 'rate_limit'
      info: { status?: string; rateLimitType?: string; [key: string]: unknown }
      raw: unknown
    }
  /** Assistant turn — N content blocks. */
  | {
      kind: 'assistant'
      blocks: NormalizedBlock[]
      model?: string
      messageId?: string
      raw: unknown
    }
  /** User turn echo — what the host (or a tool) sent in. */
  | {
      kind: 'user'
      blocks: NormalizedBlock[]
      messageId?: string
      raw: unknown
    }
  /**
   * End of a single turn. `success=false` carries `errorMessage`.
   *
   * Known structured marker values the reducer renders without the
   * `Error: …` prefix (providers should emit these when applicable):
   *   - `'error_max_turns'` → "Reached max turns"
   *   - `'interrupted_by_user'` → "Stopped"
   * Anything else is treated as a free-form error string.
   */
  | {
      kind: 'turn_result'
      success: boolean
      stopReason?: string
      usage?: TokenUsage
      errorMessage?: string
      /** Free-form summary text some providers emit (Claude `result.result`). */
      resultText?: string
      messageId?: string
      raw: unknown
    }
  /** Token-by-token streaming firehose. Renderer treats these as ephemeral. */
  | { kind: 'partial_event'; raw: unknown }
  /**
   * Subagent / Task lifecycle. Structured fields are populated by each
   * provider's translator from its native shape (Claude `system/task_*`,
   * Codex `collab_tool_call`, …) so the host broadcasts a provider-neutral
   * payload instead of leaking raw provider events over the
   * `agent:task` channel. `raw` retains the original wire payload for
   * analytics / debug.
   */
  | {
      kind: 'task_event'
      subtype: string
      taskId: string
      toolUseId?: string
      description?: string
      summary?: string
      /** Terminal status surfaced on `task_notification`. */
      status?: 'completed' | 'failed' | 'stopped'
      usage?: { totalTokens: number; toolUses: number; durationMs: number }
      lastToolName?: string
      prompt?: string
      taskType?: string
      /** Free-form patch payload — `task_updated` carries provider-shape
       *  delta info (status, description, …). */
      patch?: Record<string, unknown>
      raw: unknown
    }
  /**
   * Conversation compaction lifecycle. Emitted when a provider compacts
   * the running transcript (Claude `/compact` REPL command lifted to
   * `compact_boundary` + status messages on the wire). Provider-neutral
   * shape so renderers can render a generic chip ("Compacting…",
   * "Compacted 12k → 3k tokens", "Compaction failed: …") without keying
   * off provider-specific subtypes.
   *
   * Phases:
   *   - `'started'`: provider began compaction; UI may disable the send
   *     button + render a spinner chip
   *   - `'succeeded'`: compaction finished; `preTokens`/`postTokens` carry
   *     the size delta when the provider surfaces them
   *   - `'failed'`: compaction errored; `errorMessage` is renderer-safe
   *
   * Renderers SHOULD treat unknown phase values as ignorable to keep the
   * union extensible without breaking older hosts.
   */
  | {
      kind: 'compaction'
      phase: 'started' | 'succeeded' | 'failed'
      /** Token count before compaction, when surfaced by the provider. */
      preTokens?: number
      /** Token count after compaction, when surfaced by the provider. */
      postTokens?: number
      /** What triggered compaction — 'manual' (user typed /compact) vs 'auto' (provider's auto-compact). */
      trigger?: 'manual' | 'auto'
      /** Renderer-safe error string when `phase === 'failed'`. */
      errorMessage?: string
      messageId?: string
      raw: unknown
    }
  /** Anything we don't recognize — keep streaming, don't crash. */
  | { kind: 'unknown'; raw: unknown }

// ─── Permission flow ─────────────────────────────────────────────────────

/**
 * A "do you allow this tool" request the provider routes to the host.
 * Mirrors Claude's `canUseTool` callback context, generalized.
 */
export type NormalizedPermissionRequest = {
  toolUseId: string
  toolRef: NormalizedToolRef
  input: Record<string, unknown>
  /**
   * Provider-generated rule suggestions for "Always allow" (Claude
   * `permission_suggestions`). Echoed verbatim when the host accepts them.
   */
  suggestions?: NormalizedPermissionSuggestion[]
  /** Pre-block reason from a guard layer (e.g. workspace path policy). */
  blockedPath?: string
  decisionReason?: string
  /** Display strings the provider already prepared for the prompt UI. */
  title?: string
  description?: string
  displayName?: string
  /** When a subagent owns this request — for grouping in UI. */
  agentId?: string
  /** Original wire payload — for advanced renderers and debugging. */
  raw: unknown
}

/**
 * A persistable rule the host echoes back when the user clicks
 * "Always allow". Provider-opaque blob — never inspect `raw` outside the
 * provider package.
 */
export type NormalizedPermissionSuggestion = {
  /** Humanish description if the provider supplies one. */
  description?: string
  /** Provider-native rule body. The host MUST treat this as opaque. */
  raw: unknown
}

/**
 * The host's answer to a permission request. `classification` tells the
 * provider how to interpret the decision (one-shot vs persistent rule),
 * so analytics + audit logs can attribute correctly across providers.
 */
export type NormalizedPermissionResult = {
  behavior: 'allow' | 'deny'
  /** allow: optional rewrite of the tool input before execution. */
  updatedInput?: Record<string, unknown>
  /**
   * allow: suggestions the user accepted. Provider persists them into its
   * own settings layer — Jack itself doesn't store the allowlist.
   */
  acceptedSuggestions?: NormalizedPermissionSuggestion[]
  /** deny: explanation surfaced to the model. */
  message?: string
  /**
   * Origin of the decision — drives audit + analytics:
   *   - 'user_one_time'    user clicked Allow once
   *   - 'user_always'      user clicked Always allow (carries acceptedSuggestions)
   *   - 'user_deny'        user clicked Deny
   *   - 'auto_allow'       host policy auto-allowed (e.g. workspace read gate)
   *   - 'auto_deny'        host policy auto-denied (e.g. transversal whitelist)
   */
  classification:
    | 'user_one_time'
    | 'user_always'
    | 'user_deny'
    | 'auto_allow'
    | 'auto_deny'
}

// ─── Hook events ─────────────────────────────────────────────────────────

/**
 * Tool lifecycle events surfaced to the host outside the message stream
 * (Claude PreToolUse / PostToolUse). Used by Jack to track per-turn file
 * mutations for the workspace activity feed and trigger watcher.
 */
export type NormalizedHookEvent =
  | {
      kind: 'pre_tool_use'
      toolUseId: string
      toolRef: NormalizedToolRef
      input: unknown
      raw: unknown
    }
  | {
      kind: 'post_tool_use'
      toolUseId: string
      toolRef: NormalizedToolRef
      input: unknown
      output: unknown
      /** Path the tool wrote to, if extractable from output (Claude `filePath`). */
      filePath?: string
      /** Structured diff when available (Claude `structuredPatch`). */
      structuredPatch?: unknown
      /**
       * Canonical pre-tool file content for write-class tools (`fs.write`,
       * `fs.edit`, `notebook.edit`). Used by the host's per-turn snapshot
       * subsystem to build a "before" side for the diff editor without
       * having to read the file from disk (which would be post-write by
       * the time this event fires).
       *
       * Each provider is responsible for populating this:
       *   - **string** (incl. `''`) = the file existed pre-tool; this is
       *     its full content immediately before the write
       *   - **null** = the file did not exist pre-tool (Write created it)
       *   - **undefined** = the provider doesn't expose this signal
       *     (best-effort degraded: host records `existed=false`)
       *
       * Provider implementations:
       *   - Claude: lifted from `tool_response.originalFile`, with
       *     `type === 'create'` mapped to `null`
       *   - Codex: derived post-write from `git show HEAD:<relPath>` —
       *     best-effort, accurate when the file was committed-clean at
       *     turn start; falls back to undefined when the file is untracked
       *     or git is unavailable
       *   - Gemini: TBD by the provider plugin
       */
      originalContent?: string | null
      raw: unknown
    }
