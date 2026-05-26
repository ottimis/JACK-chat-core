import { applyUserContentPolicy, extractInfoChips, isTaskCoordinationTool } from './helpers.js'
import {
  isClaudeStreamEvent,
  type ClaudeStreamEvent
} from './internal/claude-stream.js'
import type {
  NormalizedBlock,
  NormalizedMessage,
  NormalizedToolRef,
  ToolShape
} from './normalized.js'
import { applyTaskTool } from './task-list.js'
import type {
  AgentEvent,
  ChatMessage,
  ChatState,
  ParsedChip,
  ParsedSlashEnvelope,
  ProviderUserContentPolicy,
  StreamingBlockEntry
} from './types.js'

/**
 * Build a fresh state. Pass `sessionId` up front so aggregated task-list
 * messages are scoped correctly; callers can omit it if they dispatch a
 * `reset` action with the id later.
 */
export function createInitialState(sessionId: string | null = null): ChatState {
  return {
    messages: [],
    running: false,
    statusLabel: null,
    streamingBlocks: {},
    currentAssistantId: null,
    taskCounter: 0,
    msgCounter: 0,
    sessionId
  }
}

/**
 * Host-provided clock and (optional) provider-specific text parsers.
 * Injected through the reducer's second argument so the reducer itself
 * remains a pure function of `(state, event, ctx)` and stays
 * provider-agnostic — slash-command and CLI-marker conventions live in
 * the active provider package, not here.
 */
export type ReduceContext = {
  /** Host-provided clock. Tests override this; production uses `Date.now`. */
  now: () => number
  /**
   * Optional parser for the active provider's slash-command envelope in
   * user messages (Claude wraps slash commands in `<command-name>` /
   * `<command-args>` / `<local-command-stdout>` tags inside the JSONL
   * transcript). Return null when the text doesn't match the provider's
   * envelope — the reducer renders the message as a normal user bubble.
   *
   * Providers without a slash convention (Codex, Gemini, …) simply omit
   * this callback and the reducer skips envelope detection entirely.
   */
  parseSlashEnvelope?: (text: string) => ParsedSlashEnvelope | null
  /**
   * Optional check for "this user message is only CLI markers, no real
   * content" — used by `loadHistory` to drop noise from the transcript
   * (e.g. Claude's `<local-command-stdout>...</local-command-stdout>`
   * blobs that show up between turns). Return true to drop the message.
   * Omitting the callback means "never drop" (the message renders as a
   * normal user bubble).
   */
  isCliMarkerOnly?: (text: string) => boolean
  /**
   * Whether the active provider streams assistant content as a sequence of
   * `partial_event` frames *before* the final `assistant` `NormalizedMessage`
   * arrives. Defaults to `true` for backwards compatibility (Claude's
   * behavior since v0.1) — leaving `applyAssistantFinal` to treat text and
   * thinking blocks on the final message as already-rendered.
   *
   * Set to `false` for providers whose `assistant` final is the *first* time
   * the host sees the content (Codex, Gemini, any non-streaming backend) so
   * the reducer appends text/thinking blocks as new chat messages instead
   * of dropping them on the floor. Without this flag a Codex turn never
   * produces visible chat output until the user reloads via `loadHistory`.
   */
  providerHasPartialStreaming?: boolean
  /**
   * Provider-declared rules for sanitizing user-role text before it lands
   * in the chat. Today only the wrapper-tag stripping is wired (see
   * `applyUserContentPolicy` in `helpers.ts`); future expansion (chip
   * rendering for `infoWrapperTags`) bolts on without breaking the type.
   *
   * Applied at two entry points:
   *   - `applyUserMessage` — the live `kind: 'user'` event from the wire
   *     (auto-injected boilerplate from the provider, IDE-context blocks,
   *     etc.). When stripping leaves an empty body, the bubble is dropped.
   *   - `loadHistory` — the same logic on transcript replay so reload
   *     parity with the live path is automatic.
   *
   * Provider authors declare this policy in their package alongside their
   * `JackProvider` export; the host wires it into the `ReduceContext` per
   * session at render time.
   */
  userContentPolicy?: ProviderUserContentPolicy
}

const defaultCtx: ReduceContext = { now: () => Date.now() }

/**
 * Pure reducer. Consumes one transport-agnostic event, returns the next state.
 * Does not mutate its input.
 */
export function reduce(
  state: ChatState,
  event: AgentEvent,
  ctx: ReduceContext = defaultCtx
): ChatState {
  switch (event.kind) {
    case 'reset':
      return createInitialState(event.sessionId ?? state.sessionId)

    case 'load-history': {
      // Empty history + live state in memory → no-op. Race scenario from a
      // fresh session's first turn: the host dispatches `user-prompt`
      // optimistically (bubble appears, running=true), then `system/init`
      // assigns the provider session id, which retriggers the host's
      // history-load effect with an empty transcript (nothing committed
      // to disk yet). Without this guard the optimistic user bubble (and
      // any in-flight streaming) is wiped until the SDK wire echoes the
      // user message back — the visible "first message disappears until
      // response" bug. History is authoritative only for COMMITTED turns;
      // an empty rawMessages means "nothing to load", not "clear state".
      if (event.rawMessages.length === 0 && state.messages.length > 0) {
        return state
      }
      const next = loadHistory(event.rawMessages, event.sessionId, ctx)
      // `pending-permission` messages are live state (sourced from
      // canUseTool / `pendingActions` table), not history. Without this
      // carry-over an out-of-order load — typical race in hosts that
      // hydrate pendings and history in parallel `useEffect`s — wipes
      // an inline approval card that just landed. Carry every pending
      // forward; resolution / republish will reconcile by toolUseID.
      const pendings = state.messages.filter((m) => m.type === 'pending-permission')
      if (pendings.length === 0) return next
      const existing = new Set(next.messages.map((m) => m.id))
      const carry = pendings.filter((m) => !existing.has(m.id))
      if (carry.length === 0) return next
      return { ...next, messages: [...next.messages, ...carry] }
    }

    case 'sdk':
      return applySdkMessage(state, event.message, ctx)

    case 'permission-request':
      return applyPermissionRequest(state, event.data, ctx)

    case 'file-change':
      return applyFileChange(state, event.data, ctx)

    case 'agent-error': {
      const { state: s2, id } = bumpId(state)
      return {
        ...s2,
        running: false,
        streamingBlocks: {},
        currentAssistantId: null,
        messages: [
          ...s2.messages,
          {
            id,
            type: 'result',
            content: `Error: ${event.error}`,
            timestamp: ctx.now()
          }
        ]
      }
    }

    case 'slash-feedback': {
      const { state: s2, id } = bumpId(state)
      return {
        ...s2,
        messages: [
          ...s2.messages,
          {
            id,
            type: 'slash-feedback',
            content: event.text,
            feedbackStatus: event.status ?? 'ok',
            timestamp: ctx.now()
          }
        ]
      }
    }

    case 'context-usage': {
      const { state: s2, id } = bumpId(state)
      return {
        ...s2,
        messages: [
          ...s2.messages,
          {
            id,
            type: 'context-usage',
            content: '',
            contextUsage: event.usage,
            timestamp: ctx.now()
          }
        ]
      }
    }

    case 'user-prompt': {
      const { state: s2, id } = bumpId(state)
      return {
        ...s2,
        running: true,
        messages: [
          ...s2.messages,
          {
            id,
            type: 'user',
            content: event.text,
            timestamp: ctx.now()
          }
        ]
      }
    }

    case 'turn-started': {
      // Dedup: if a client (desktop or a mobile originator) already dispatched
      // `user-prompt` locally for this exact turn, the most recent user
      // message in state already carries the same text. Echoing it again
      // would produce a duplicate bubble. Passive observers (e.g. a mobile
      // watching a desktop session) land in the `else` branch and get the
      // bubble + `running: true` immediately.
      for (let i = state.messages.length - 1; i >= 0; i--) {
        const m = state.messages[i]
        if (!m || m.type !== 'user') continue
        if (m.content === event.text) {
          return state.running ? state : { ...state, running: true }
        }
        break
      }
      const { state: s2, id } = bumpId(state)
      return {
        ...s2,
        running: true,
        messages: [
          ...s2.messages,
          {
            id,
            type: 'user',
            content: event.text,
            timestamp: ctx.now()
          }
        ]
      }
    }

    case 'slash-invocation': {
      // Normalise the command name: strip a single leading '/' if present so
      // client-dispatched invocations render identically to chips derived from
      // the `<command-name>` envelope parser (which captures the bare name).
      const commandName = event.name.startsWith('/') ? event.name.slice(1) : event.name
      const { state: s2, id } = bumpId(state)
      return {
        ...s2,
        messages: [
          ...s2.messages,
          {
            id,
            type: 'slash-command',
            content: '',
            commandName,
            ...(event.args !== undefined && event.args.length > 0
              ? { commandArgs: event.args }
              : {}),
            timestamp: ctx.now()
          }
        ]
      }
    }

    case 'permission-resolved': {
      if (event.decision === 'deny') {
        return {
          ...state,
          messages: state.messages.filter((m) => m.id !== event.toolUseID)
        }
      }
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === event.toolUseID ? { ...m, streaming: true } : m
        )
      }
    }

    case 'interrupt': {
      return {
        ...state,
        running: false,
        statusLabel: null,
        streamingBlocks: {},
        currentAssistantId: null,
        messages: state.messages.some((m) => m.streaming)
          ? state.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m))
          : state.messages
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal handlers
// ─────────────────────────────────────────────────────────────────────────────

function applySdkMessage(
  state: ChatState,
  message: NormalizedMessage,
  ctx: ReduceContext
): ChatState {
  switch (message.kind) {
    case 'partial_event':
      return applyPartialEvent(state, message.raw, ctx)
    case 'assistant':
      return applyAssistantFinal(state, message.blocks, ctx)
    case 'user':
      return applyUserMessage(state, message.blocks, ctx, message.messageId)
    case 'turn_result': {
      const next: ChatState = {
        ...state,
        running: false,
        statusLabel: null,
        streamingBlocks: {},
        currentAssistantId: null,
        messages: state.messages.some((m) => m.streaming)
          ? state.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m))
          : state.messages
      }
      if (message.success) return next
      const { state: s2, id } = bumpId(next)
      const errorContent =
        message.errorMessage === 'error_max_turns'
          ? 'Reached max turns'
          : message.errorMessage === 'interrupted_by_user'
            ? 'Stopped'
            : message.errorMessage
              ? `Error: ${message.errorMessage}`
              : 'Error: unknown'
      return {
        ...s2,
        messages: [
          ...s2.messages,
          {
            id,
            type: 'result',
            content: errorContent,
            timestamp: ctx.now()
          }
        ]
      }
    }
    case 'session_state': {
      // `requires_action` is the "waiting on a permission decision" hint —
      // the pending-permission card already covers the UI signal, so no
      // status label is added here. `Compacting` as a label is currently
      // unreachable through normalized state (see the TODO in normalized.ts);
      // it stays in `StatusLabel` for binary compatibility until a follow-up
      // contract update introduces a dedicated kind/state for it.
      return {
        ...state,
        statusLabel: message.state === 'running' ? 'Thinking' : null
      }
    }
    case 'compaction': {
      // Surface compaction as a centred system row in the transcript so the
      // user always has an audit trail of "Conversation compacted X → Y
      // tokens" between the pre-compact and post-compact assistant turns.
      // The chip's progress hint (Compacting…) is a separate UI concern
      // gated by the per-session live status state — handled outside the
      // reducer. We only persist the terminal phases here so reloading the
      // chat keeps the boundary marker visible.
      if (message.phase === 'started') {
        // No persisted row — the in-flight chip is the statusLabel. Avoids a
        // placeholder chat row that would have to be replaced when the
        // boundary lands. `running:true` keeps the composer in "agent busy"
        // mode so the user can't fire turns while compaction is in progress.
        return {
          ...state,
          running: true,
          statusLabel: 'Compacting'
        }
      }
      const { state: s2, id } = bumpId(state)
      const headline =
        message.phase === 'failed'
          ? `Compaction failed${message.errorMessage ? `: ${message.errorMessage}` : ''}`
          : message.preTokens && message.postTokens
            ? `Conversation compacted (${message.preTokens.toLocaleString()} → ${message.postTokens.toLocaleString()} tokens)`
            : 'Conversation compacted'
      return {
        ...s2,
        // Clear the in-flight flag the started phase set; turn_result will
        // also fire later (the next user turn boundary) but the composer
        // shouldn't stay locked while we wait for it.
        statusLabel: null,
        messages: [
          ...s2.messages,
          {
            id,
            type: 'result',
            content: headline,
            timestamp: ctx.now()
          }
        ]
      }
    }
    case 'session_init':
    case 'rate_limit':
    case 'task_event':
    case 'unknown':
      // Not consumed by the chat reducer today — preserve state rather than
      // fall through and return `undefined`.
      return state
  }
}

function applyPartialEvent(
  state: ChatState,
  raw: unknown,
  ctx: ReduceContext
): ChatState {
  // Today only Claude emits token-level streaming. Other providers ship
  // `partial_event` with their own raw shape, which the reducer cannot yet
  // decode — drop silently until a normalized partial-block event lands.
  if (!isClaudeStreamEvent(raw)) return state
  return applyStreamEvent(state, raw.event, ctx)
}

function applyStreamEvent(
  state: ChatState,
  event: ClaudeStreamEvent | undefined,
  ctx: ReduceContext
): ChatState {
  if (!event) return state

  switch (event.type) {
    case 'content_block_start': {
      const block = event.content_block
      const idx = event.index
      const blockType = block?.type

      if (blockType === 'thinking' || blockType === 'text') {
        let currentAssistantId = state.currentAssistantId
        if (!currentAssistantId) {
          currentAssistantId = `assistant-${ctx.now()}-${idx}`
        }
        return {
          ...state,
          currentAssistantId,
          running: true,
          streamingBlocks: {
            ...state.streamingBlocks,
            [idx]: { id: currentAssistantId, blockType }
          }
        }
      }

      if (blockType === 'tool_use') {
        const rawId = block?.id
        const id = typeof rawId === 'string' && rawId.length > 0 ? rawId : `tool-${idx}-${ctx.now()}`
        const name = block?.name

        // Close the current text/thinking bubble so its streaming flag clears
        // and a new assistant grouping can start after the tool.
        let messages = state.messages
        if (state.currentAssistantId) {
          const targetId = state.currentAssistantId
          messages = messages.map((m) => (m.id === targetId ? { ...m, streaming: false } : m))
        }

        const nextStreaming: Record<number, StreamingBlockEntry> = {
          ...state.streamingBlocks,
          [idx]: { id, blockType: 'tool' }
        }

        // Aggregated Task tools: no placeholder card, the task-list widget is
        // updated when the final 'assistant' message arrives. The streaming
        // event only carries the wire name (e.g. `mcp__jack__TaskCreate`,
        // or Claude SDK's bare `TaskCreate`), so we do prefix-aware matching
        // here without going through a full NormalizedToolRef parse.
        //
        // Note: matching bare names like `TaskCreate` here keeps a small
        // amount of provider-naming knowledge in the reducer for the
        // streaming-start window only — the authoritative routing happens
        // in `isTaskCoordinationTool` once the assistant final arrives with
        // a fully resolved `NormalizedToolRef`. A non-task provider that
        // happens to ship a tool literally named `TaskCreate` would briefly
        // suppress the placeholder card here, then render normally as a
        // generic tool once the final message lands.
        //
        // We also intentionally DROP this block from `streamingBlocks`:
        // since no chat row owns the tool's id, the upcoming
        // `input_json_delta` events for this index would otherwise land
        // in `appendDelta(state, toolUseId, 'content', ...)`, miss the
        // (non-existent) target row, and synthesize a stray `assistant`
        // bubble per task call carrying the partial JSON. Skipping the
        // entry here turns those deltas into safe no-ops.
        if (isTaskWireName(name)) {
          return {
            ...state,
            messages,
            currentAssistantId: null,
            running: true
          }
        }

        // Skip if a pending-permission card already owns this id.
        if (messages.some((m) => m.id === id)) {
          return {
            ...state,
            messages,
            streamingBlocks: nextStreaming,
            currentAssistantId: null,
            running: true
          }
        }

        return {
          ...state,
          currentAssistantId: null,
          running: true,
          streamingBlocks: nextStreaming,
          messages: [
            ...messages,
            {
              id,
              type: 'tool',
              content: '',
              toolName: name,
              toolStatus: 'running',
              timestamp: ctx.now(),
              streaming: true
            }
          ]
        }
      }

      return state
    }

    case 'content_block_delta': {
      const entry = state.streamingBlocks[event.index]
      if (!entry || !event.delta) return state
      if (event.delta.type === 'text_delta' && event.delta.text) {
        return appendDelta(state, entry.id, 'content', event.delta.text, ctx)
      }
      if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
        return appendDelta(state, entry.id, 'thinking', event.delta.thinking, ctx)
      }
      if (event.delta.type === 'input_json_delta' && event.delta.partial_json) {
        return appendDelta(state, entry.id, 'content', event.delta.partial_json, ctx)
      }
      return state
    }

    case 'content_block_stop': {
      const { [event.index]: _removed, ...rest } = state.streamingBlocks
      return { ...state, streamingBlocks: rest }
    }

    case 'message_stop': {
      let messages = state.messages
      if (state.currentAssistantId) {
        const targetId = state.currentAssistantId
        messages = messages.map((m) => (m.id === targetId ? { ...m, streaming: false } : m))
      }
      return {
        ...state,
        messages,
        streamingBlocks: {},
        currentAssistantId: null
      }
    }

    default:
      // Unknown stream event types (e.g. `message_start`, `message_delta`,
      // `ping`) forwarded verbatim from the SDK — ignore but preserve state.
      // Falling through would return `undefined` and crash the next dispatch.
      return state
  }
}

function applyAssistantFinal(
  state: ChatState,
  blocks: NormalizedBlock[],
  ctx: ReduceContext
): ChatState {
  let next = state

  // Providers without partial streaming deliver text and thinking on the
  // final assistant message — there's no prior `partial_event` flow to
  // surface them via `applyStreamEvent`. Mirror what `loadHistory` does for
  // historical replay so live turns render the same way without a reload.
  if (ctx.providerHasPartialStreaming === false) {
    const texts = blocks
      .filter((b): b is Extract<NormalizedBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
    const thinking = blocks
      .filter((b): b is Extract<NormalizedBlock, { type: 'thinking' }> => b.type === 'thinking')
      .map((b) => b.text)
      .join('\n')
    if (texts || thinking) {
      const { state: s2, id } = bumpId(next)
      next = {
        ...s2,
        messages: [
          ...s2.messages,
          {
            id,
            type: 'assistant' as const,
            content: texts,
            ...(thinking ? { thinking } : {}),
            timestamp: ctx.now()
          }
        ]
      }
    }
  }

  for (const block of blocks) {
    if (block.type !== 'tool_use') continue
    if (!block.toolUseId) continue

    if (isTaskCoordinationTool(block.toolRef)) {
      const sessionId = next.sessionId ?? 'global'
      const result = applyTaskTool(
        next.messages,
        sessionId,
        block.toolRef.toolName,
        toRecord(block.input),
        next.taskCounter,
        ctx.now()
      )
      next = { ...next, messages: result.messages, taskCounter: result.taskCounter }
      continue
    }

    const ref = block.toolRef
    const shapeFields = toolShapeFields(ref)
    const existing = next.messages.find((m) => m.id === block.toolUseId)
    if (existing) {
      // Streaming providers (Claude) created the tool message during the
      // partial-event phase in 'running' state; the assistant final seals
      // it as 'done'.
      next = {
        ...next,
        messages: next.messages.map((m) =>
          m.id === block.toolUseId
            ? {
                ...m,
                toolStatus: 'done' as const,
                streaming: false,
                toolInput: toRecord(block.input),
                ...shapeFields
              }
            : m
        )
      }
    } else {
      // Non-streaming providers (Codex, Gemini, anything emitting tool_use
      // only on the assistant final): the assistant message is the FIRST
      // time we see the tool, so we have to push a new chat row.
      // toolStatus stays 'running' — the matching tool_result block (in a
      // subsequent 'user' message) flips it to done/error via
      // applyUserMessage. Without this branch, gemini/codex live runs would
      // show only the assistant's text+thinking but no tool cards until the
      // user reloaded via loadHistory (which DOES create per-tool rows).
      const toolName =
        block.toolRef.kind === 'native' ? block.toolRef.toolName : block.toolRef.raw
      const { state: s2, id: bumpedId } = bumpId(next)
      next = {
        ...s2,
        messages: [
          ...s2.messages,
          {
            id: block.toolUseId || bumpedId,
            type: 'tool',
            content: '',
            toolName,
            toolInput: toRecord(block.input),
            toolStatus: 'running',
            timestamp: ctx.now(),
            ...shapeFields
          }
        ]
      }
    }
  }
  return next
}

function applyUserMessage(
  state: ChatState,
  blocks: NormalizedBlock[],
  ctx: ReduceContext,
  providerMessageId?: string
): ChatState {
  let next = state
  const textBlobs: string[] = []
  const blobChips: readonly ParsedChip[][] = []
  const chipBlobs: ParsedChip[] = []

  for (const block of blocks) {
    if (block.type === 'tool_result') {
      const targetId = block.toolUseId
      if (!targetId) continue
      const nextStatus: 'error' | 'done' = block.isError ? 'error' : 'done'
      // Coerce content to a string so the tool card renders something for
      // non-streaming providers (Codex/Gemini deliver final output only on
      // tool_result; Claude streams it as text deltas into the same row
      // earlier and arrives here with a non-string `content` whose presence
      // we don't want to overwrite). Skip the content overwrite when it's
      // empty so a streamed-from-Claude row keeps its accumulated text.
      const contentText =
        typeof block.content === 'string' ? block.content
        : block.content == null ? ''
        : Array.isArray(block.content) ? block.content
            .map((x) => (typeof x === 'object' && x && 'text' in x ? String((x as { text: unknown }).text ?? '') : ''))
            .filter(Boolean).join('\n')
        : ''
      next = {
        ...next,
        messages: next.messages.map((m) =>
          m.id === targetId
            ? {
                ...m,
                toolStatus: nextStatus,
                streaming: false,
                ...(contentText && !m.content ? { content: contentText } : {})
              }
            : m
        )
      }
    } else if (block.type === 'text' && typeof block.text === 'string') {
      // Apply the provider's user-content policy before any downstream
      // dispatch — slash detection, history bubble, etc. all run on the
      // sanitized text. When the policy strips everything but `infoWrapperTags`
      // matched, we still surface a chip-only bubble so the user sees the
      // async event (e.g. a background bash completion) the model just received.
      const chips = extractInfoChips(block.text, ctx.userContentPolicy)
      const cleaned = applyUserContentPolicy(block.text, ctx.userContentPolicy)
      if (cleaned) {
        textBlobs.push(cleaned)
        ;(blobChips as ParsedChip[][]).push([...chips])
      } else if (chips.length > 0) {
        chipBlobs.push(...chips)
      }
    }
  }

  for (let i = 0; i < textBlobs.length; i++) {
    const text = textBlobs[i]!
    const chips = blobChips[i] ?? []
    const envelope = ctx.parseSlashEnvelope?.(text)
    if (envelope) {
      const { state: s2, id } = bumpId(next)
      next = {
        ...s2,
        messages: [
          ...s2.messages,
          {
            id,
            type: 'slash-command',
            content: '',
            commandName: envelope.commandName,
            ...(envelope.commandArgs !== undefined ? { commandArgs: envelope.commandArgs } : {}),
            ...(envelope.commandStdout !== undefined
              ? { commandStdout: envelope.commandStdout }
              : {}),
            ...(providerMessageId ? { providerMessageId } : {}),
            timestamp: ctx.now()
          }
        ]
      }
      // Chips paired with a slash envelope still deserve to render — emit
      // them as a separate user bubble so the slash card stays clean.
      if (chips.length > 0) {
        next = appendChipOnlyUserBubble(next, chips, ctx, providerMessageId)
      }
    } else if (chips.length > 0) {
      // Non-slash synthetic user text WITH chips — emit a chip-bearing
      // user bubble. (Plain non-slash text without chips is dropped to
      // preserve current behavior: live applyUserMessage doesn't echo
      // user-typed content, that path is owned by `user-prompt`.)
      next = appendChipBearingUserBubble(next, text, chips, ctx, providerMessageId)
    }
  }

  // Pure chip extractions from text blocks that were fully stripped.
  if (chipBlobs.length > 0) {
    next = appendChipOnlyUserBubble(next, chipBlobs, ctx, providerMessageId)
  }

  return next
}

function appendChipOnlyUserBubble(
  state: ChatState,
  chips: readonly ParsedChip[],
  ctx: ReduceContext,
  providerMessageId?: string
): ChatState {
  const { state: s2, id } = bumpId(state)
  return {
    ...s2,
    messages: [
      ...s2.messages,
      {
        id,
        type: 'user',
        content: '',
        chips,
        ...(providerMessageId ? { providerMessageId } : {}),
        timestamp: ctx.now()
      }
    ]
  }
}

function appendChipBearingUserBubble(
  state: ChatState,
  text: string,
  chips: readonly ParsedChip[],
  ctx: ReduceContext,
  providerMessageId?: string
): ChatState {
  const { state: s2, id } = bumpId(state)
  return {
    ...s2,
    messages: [
      ...s2.messages,
      {
        id,
        type: 'user',
        content: text,
        chips,
        ...(providerMessageId ? { providerMessageId } : {}),
        timestamp: ctx.now()
      }
    ]
  }
}

function applyPermissionRequest(
  state: ChatState,
  data: import('./preload-types.js').PermissionRequestData,
  ctx: ReduceContext
): ChatState {
  // Previously we required `inlineFileDiff` and relied on desktop rendering
  // non-inline requests via a floating PermissionCard. Mobile has no such
  // floating UI, so the user would just see "waiting_input" and nothing
  // actionable in the chat. The filter now lives at the desktop dispatch
  // site (`AgentChat.tsx` drops non-inline requests before dispatching), so
  // the reducer itself is permissive and adds a card for any request it gets.
  const id = data.toolUseID ?? `perm-${ctx.now()}`
  const without = state.messages.filter((m) => m.id !== id)
  return {
    ...state,
    messages: [
      ...without,
      {
        id,
        type: 'pending-permission',
        content: '',
        pendingPermission: data,
        timestamp: ctx.now()
      }
    ]
  }
}

function applyFileChange(
  state: ChatState,
  data: import('./preload-types.js').FileChangeData,
  ctx: ReduceContext
): ChatState {
  const idx = state.messages.findIndex((m) => m.id === data.toolUseId)
  if (idx >= 0) {
    const next = [...state.messages]
    next[idx] = {
      id: data.toolUseId,
      type: 'file-diff',
      content: '',
      fileChange: data,
      timestamp: ctx.now()
    }
    return { ...state, messages: next }
  }
  const { state: s2, id } = bumpId(state)
  return {
    ...s2,
    messages: [
      ...s2.messages,
      {
        id,
        type: 'file-diff',
        content: '',
        fileChange: data,
        timestamp: ctx.now()
      }
    ]
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal utilities
// ─────────────────────────────────────────────────────────────────────────────

function bumpId(state: ChatState): { state: ChatState; id: string } {
  const next = state.msgCounter + 1
  return { state: { ...state, msgCounter: next }, id: String(next) }
}

function appendDelta(
  state: ChatState,
  id: string,
  field: 'content' | 'thinking',
  delta: string,
  ctx: ReduceContext
): ChatState {
  const exists = state.messages.some((m) => m.id === id)
  if (exists) {
    return {
      ...state,
      messages: state.messages.map((m) =>
        m.id === id ? { ...m, [field]: (m[field] ?? '') + delta } : m
      )
    }
  }
  const newMessage: ChatMessage = {
    id,
    type: 'assistant',
    content: field === 'content' ? delta : '',
    timestamp: ctx.now(),
    streaming: true,
    ...(field === 'thinking' ? { thinking: delta } : {})
  }
  return {
    ...state,
    messages: [...state.messages, newMessage]
  }
}

function toRecord(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== 'object') return undefined
  return input as Record<string, unknown>
}

/**
 * Project a `NormalizedToolRef` onto the trio of fields the renderer keys
 * off. Native tools carry their `shape` from the provider's tool catalog;
 * MCP-routed tools always map to `'mcp'` and carry the server slug.
 *
 * `'unknown'` shape is preserved verbatim (not coerced to `undefined`) so
 * the renderer can pick a generic JSON view rather than fall back to
 * provider-name pattern matching.
 */
function toolShapeFields(ref: NormalizedToolRef): {
  toolShape: ToolShape
  toolRefKind: 'native' | 'mcp'
  toolMcpServerSlug?: string
} {
  if (ref.kind === 'native') {
    return { toolShape: ref.shape, toolRefKind: 'native' }
  }
  return { toolShape: 'mcp', toolRefKind: 'mcp', toolMcpServerSlug: ref.serverSlug }
}

const TASK_WIRE_NAMES: ReadonlySet<string> = new Set([
  // Jack MCP server route (back-compat with providers that don't have
  // native task tools — Codex, Gemini today).
  'mcp__jack__TaskCreate',
  'mcp__jack__TaskUpdate',
  'mcp__jack__TaskList',
  'mcp__jack__TaskGet',
  'mcp__jack__TaskStop',
  'mcp__jack__TaskOutput',
  'mcp__jack__TaskDelete',
  // Bare names emitted by providers whose native catalog declares them
  // with `shape: 'task'`. Listing them keeps the streaming-start path
  // from creating a placeholder card before the assistant final arrives
  // with the resolved shape.
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'TaskStop',
  'TaskOutput',
  'TaskDelete'
])

function isTaskWireName(name?: string): boolean {
  return !!name && TASK_WIRE_NAMES.has(name)
}

// ─────────────────────────────────────────────────────────────────────────────
// History replay
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rebuild a `ChatMessage[]` from a recorded transcript expressed as
 * provider-neutral `NormalizedMessage[]`. Unlike `reduce`, this operates on
 * finalised turns (no streaming deltas), so the logic is a flat iteration
 * rather than delta accumulation.
 *
 * Internal counters are exposed on the returned state so the caller can keep
 * consuming live events without id collisions.
 */
export function loadHistory(
  rawMessages: NormalizedMessage[],
  sessionId: string,
  ctx: ReduceContext = defaultCtx
): ChatState {
  let state = createInitialState(sessionId)

  for (const msg of rawMessages) {
    if (msg.kind === 'user') {
      const rawText = msg.blocks
        .filter((b): b is NormalizedBlock & { type: 'text' } => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
      if (!rawText) continue
      // Strip provider-declared wrapper tags before slash detection / bubble
      // creation. Keeps history replay aligned with the live `applyUserMessage`
      // path so a Cmd+R refresh shows the same content as the streaming view.
      // Chips are extracted from the same raw text BEFORE strip, so an
      // info-wrapper that fully consumes the user message still surfaces
      // as a chip-only bubble (e.g. Claude's `<task-notification>`).
      const chips = extractInfoChips(rawText, ctx.userContentPolicy)
      const text = applyUserContentPolicy(rawText, ctx.userContentPolicy)
      if (!text && chips.length === 0) continue

      const providerMessageId = msg.messageId
      const envelope = text ? ctx.parseSlashEnvelope?.(text) : null
      if (envelope) {
        const { state: s2, id } = bumpId(state)
        state = {
          ...s2,
          messages: [
            ...s2.messages,
            {
              id,
              type: 'slash-command',
              content: '',
              commandName: envelope.commandName,
              ...(envelope.commandArgs !== undefined ? { commandArgs: envelope.commandArgs } : {}),
              ...(envelope.commandStdout !== undefined
                ? { commandStdout: envelope.commandStdout }
                : {}),
              ...(providerMessageId ? { providerMessageId } : {}),
              timestamp: 0
            }
          ]
        }
        // Chips alongside a slash envelope render as their own bubble.
        if (chips.length > 0) {
          const { state: s3, id: chipId } = bumpId(state)
          state = {
            ...s3,
            messages: [
              ...s3.messages,
              {
                id: chipId,
                type: 'user',
                content: '',
                chips,
                ...(providerMessageId ? { providerMessageId } : {}),
                timestamp: 0
              }
            ]
          }
        }
      } else if (text && !ctx.isCliMarkerOnly?.(text)) {
        const { state: s2, id } = bumpId(state)
        state = {
          ...s2,
          messages: [
            ...s2.messages,
            {
              id,
              type: 'user',
              content: text,
              ...(chips.length > 0 ? { chips } : {}),
              ...(providerMessageId ? { providerMessageId } : {}),
              timestamp: 0
            }
          ]
        }
      } else if (chips.length > 0) {
        // Chip-only injection (CLI marker or fully-stripped text). Surface
        // the chips on their own user bubble so the timeline preserves the
        // async event.
        const { state: s2, id } = bumpId(state)
        state = {
          ...s2,
          messages: [
            ...s2.messages,
            {
              id,
              type: 'user',
              content: '',
              chips,
              ...(providerMessageId ? { providerMessageId } : {}),
              timestamp: 0
            }
          ]
        }
      }
      continue
    }

    if (msg.kind === 'assistant') {
      const blocks = msg.blocks
      const texts = blocks
        .filter((b): b is NormalizedBlock & { type: 'text' } => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
      const thinkingTexts = blocks
        .filter(
          (b): b is NormalizedBlock & { type: 'thinking' } => b.type === 'thinking'
        )
        .map((b) => b.text)
        .join('\n')

      if (texts || thinkingTexts) {
        const { state: s2, id } = bumpId(state)
        state = {
          ...s2,
          messages: [
            ...s2.messages,
            {
              id,
              type: 'assistant',
              content: texts,
              ...(thinkingTexts ? { thinking: thinkingTexts } : {}),
              timestamp: 0
            }
          ]
        }
      }

      for (const block of blocks) {
        if (block.type !== 'tool_use') continue

        if (isTaskCoordinationTool(block.toolRef)) {
          const result = applyTaskTool(
            state.messages,
            sessionId,
            block.toolRef.toolName,
            toRecord(block.input),
            state.taskCounter,
            ctx.now()
          )
          state = { ...state, messages: result.messages, taskCounter: result.taskCounter }
          continue
        }

        const { state: s2, id: fallbackId } = bumpId(state)
        const id = block.toolUseId || fallbackId
        const toolName =
          block.toolRef.kind === 'native' ? block.toolRef.toolName : block.toolRef.raw
        const shapeFields = toolShapeFields(block.toolRef)
        state = {
          ...s2,
          messages: [
            ...s2.messages,
            {
              id,
              type: 'tool',
              content: '',
              toolName,
              toolInput: toRecord(block.input),
              toolStatus: 'done',
              timestamp: 0,
              ...shapeFields
            }
          ]
        }
      }
    }
  }

  return state
}
