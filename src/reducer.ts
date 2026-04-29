import { isJackTaskTool } from './helpers.js'
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
  ParsedSlashEnvelope,
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

    case 'load-history':
      return loadHistory(event.rawMessages, event.sessionId, ctx)

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
      return applyUserMessage(state, message.blocks, ctx)
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
        // event only carries the wire name (e.g. `mcp__jack__TaskCreate`),
        // so we do prefix-aware matching here without going through a full
        // NormalizedToolRef parse.
        if (isTaskWireName(name)) {
          return {
            ...state,
            messages,
            streamingBlocks: nextStreaming,
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
  for (const block of blocks) {
    if (block.type !== 'tool_use') continue
    if (!block.toolUseId) continue

    if (isJackTaskTool(block.toolRef)) {
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
  }
  return next
}

function applyUserMessage(
  state: ChatState,
  blocks: NormalizedBlock[],
  ctx: ReduceContext
): ChatState {
  let next = state
  const textBlobs: string[] = []

  for (const block of blocks) {
    if (block.type === 'tool_result') {
      const targetId = block.toolUseId
      if (!targetId) continue
      const nextStatus: 'error' | 'done' = block.isError ? 'error' : 'done'
      next = {
        ...next,
        messages: next.messages.map((m) =>
          m.id === targetId ? { ...m, toolStatus: nextStatus, streaming: false } : m
        )
      }
    } else if (block.type === 'text' && typeof block.text === 'string') {
      textBlobs.push(block.text)
    }
  }

  for (const text of textBlobs) {
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
            timestamp: ctx.now()
          }
        ]
      }
    }
  }

  return next
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
  'mcp__jack__TaskCreate',
  'mcp__jack__TaskUpdate',
  'mcp__jack__TaskList',
  'mcp__jack__TaskGet'
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
      const text = msg.blocks
        .filter((b): b is NormalizedBlock & { type: 'text' } => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
      if (!text) continue

      const envelope = ctx.parseSlashEnvelope?.(text)
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
              timestamp: 0
            }
          ]
        }
      } else if (!ctx.isCliMarkerOnly?.(text)) {
        const { state: s2, id } = bumpId(state)
        state = {
          ...s2,
          messages: [...s2.messages, { id, type: 'user', content: text, timestamp: 0 }]
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

        if (isJackTaskTool(block.toolRef)) {
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
