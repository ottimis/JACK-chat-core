import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createInitialState, reduce, loadHistory } from '../src/reducer.js'
import type { ReduceContext } from '../src/reducer.js'
import type { AgentEvent, ParsedSlashEnvelope } from '../src/types.js'
import type { NormalizedMessage } from '../src/normalized.js'
import {
  assistantMsg,
  claudeStream,
  mcpBlock,
  mcpToolUse,
  nativeToolUse,
  sessionState,
  textBlock,
  toolResult,
  turnResultError,
  turnResultSuccess,
  userMsg
} from './helpers/fixtures.js'

const SID = 'session-1'

// Inline reimpl of the Claude slash-envelope parsers — historically lived
// in `src/helpers.ts` but moved out of chat-core in 0.5.0 (the reducer is
// provider-neutral). These mock the same shape the host's provider package
// will inject via ReduceContext at runtime, so the tests still cover
// envelope detection without reintroducing the removed exports.
function claudeParseEnvelope(text: string): ParsedSlashEnvelope | null {
  if (!text.trimStart().startsWith('<command-name>')) return null
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)
  if (!name || !name[1]) return null
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)
  const stdout = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(text)
  const commandName = name[1].trim()
  if (!commandName) return null
  return {
    commandName,
    commandArgs: args && args[1] ? args[1].trim() : undefined,
    commandStdout: stdout && stdout[1] ? stdout[1] : undefined
  }
}

const CLI_MARKER_PATTERNS: readonly RegExp[] = [
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
  /<local-command-stderr>[\s\S]*?<\/local-command-stderr>/g,
  /<command-name>[\s\S]*?<\/command-name>/g,
  /<command-args>[\s\S]*?<\/command-args>/g,
  /<command-message>[\s\S]*?<\/command-message>/g
]
function claudeIsCliMarkerOnly(text: string): boolean {
  let stripped = text
  for (const pattern of CLI_MARKER_PATTERNS) stripped = stripped.replace(pattern, '')
  return stripped.trim().length === 0
}

const ctx: ReduceContext = { now: () => 1_000_000 }
const slashCtx: ReduceContext = {
  now: () => 1_000_000,
  parseSlashEnvelope: claudeParseEnvelope,
  isCliMarkerOnly: claudeIsCliMarkerOnly
}

function run(events: AgentEvent[], runCtx: ReduceContext = ctx) {
  let state = createInitialState(SID)
  for (const ev of events) state = reduce(state, ev, runCtx)
  return state
}

describe('reducer — streaming assistant turn', () => {
  it('builds a single assistant bubble from thinking + text deltas', () => {
    const state = run([
      { kind: 'sdk', message: claudeStream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }) },
      { kind: 'sdk', message: claudeStream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm ' } }) },
      { kind: 'sdk', message: claudeStream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'let me see' } }) },
      { kind: 'sdk', message: claudeStream({ type: 'content_block_stop', index: 0 }) },
      { kind: 'sdk', message: claudeStream({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }) },
      { kind: 'sdk', message: claudeStream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello ' } }) },
      { kind: 'sdk', message: claudeStream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'world' } }) },
      { kind: 'sdk', message: claudeStream({ type: 'content_block_stop', index: 1 }) },
      { kind: 'sdk', message: claudeStream({ type: 'message_stop' }) }
    ])

    assert.equal(state.messages.length, 1)
    const m = state.messages[0]!
    assert.equal(m.type, 'assistant')
    assert.equal(m.thinking, 'hmm let me see')
    assert.equal(m.content, 'Hello world')
    assert.equal(m.streaming, false)
    assert.equal(state.currentAssistantId, null)
  })

  it('interrupts assistant bubble when a tool_use starts', () => {
    const state = run([
      { kind: 'sdk', message: claudeStream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }) },
      { kind: 'sdk', message: claudeStream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'checking...' } }) },
      { kind: 'sdk', message: claudeStream({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'Read' } }) }
    ])

    assert.equal(state.messages.length, 2)
    const assistant = state.messages[0]!
    const tool = state.messages[1]!
    assert.equal(assistant.type, 'assistant')
    assert.equal(assistant.streaming, false, 'assistant stream flag cleared when tool started')
    assert.equal(tool.type, 'tool')
    assert.equal(tool.toolName, 'Read')
    assert.equal(tool.id, 'tu_1')
    assert.equal(tool.toolStatus, 'running')
    assert.equal(state.currentAssistantId, null)
  })

  it('marks tool as done on matching tool_result', () => {
    let state = run([
      { kind: 'sdk', message: claudeStream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'Read' } }) },
      { kind: 'sdk', message: claudeStream({ type: 'content_block_stop', index: 0 }) },
      { kind: 'sdk', message: assistantMsg([nativeToolUse('Read', 'fs.read', 'tu_1', { file_path: '/foo' })]) }
    ])
    state = reduce(
      state,
      { kind: 'sdk', message: userMsg([toolResult('tu_1', false)]) },
      ctx
    )
    const tool = state.messages.find((m) => m.id === 'tu_1')!
    assert.equal(tool.toolStatus, 'done')
    assert.deepEqual(tool.toolInput, { file_path: '/foo' })
    assert.equal(tool.toolShape, 'fs.read')
    assert.equal(tool.toolRefKind, 'native')
    assert.equal(tool.toolMcpServerSlug, undefined)
  })
})

describe('reducer — toolShape projection (0.4.1)', () => {
  it('populates toolShape and toolRefKind for a known native tool', () => {
    let state = run([
      {
        kind: 'sdk',
        message: claudeStream({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tu_w', name: 'Write' }
        })
      }
    ])
    state = reduce(
      state,
      { kind: 'sdk', message: assistantMsg([nativeToolUse('Write', 'fs.write', 'tu_w', { file_path: '/x', content: 'hi' })]) },
      ctx
    )
    const tool = state.messages.find((m) => m.id === 'tu_w')!
    assert.equal(tool.toolShape, 'fs.write')
    assert.equal(tool.toolRefKind, 'native')
    assert.equal(tool.toolMcpServerSlug, undefined)
    assert.equal(tool.toolName, 'Write')
  })

  it("preserves shape='unknown' verbatim for native tools without a catalog entry", () => {
    let state = run([
      {
        kind: 'sdk',
        message: claudeStream({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tu_u', name: 'CustomTool' }
        })
      }
    ])
    state = reduce(
      state,
      { kind: 'sdk', message: assistantMsg([nativeToolUse('CustomTool', 'unknown', 'tu_u', { foo: 'bar' })]) },
      ctx
    )
    const tool = state.messages.find((m) => m.id === 'tu_u')!
    assert.equal(tool.toolShape, 'unknown', 'unknown shape kept, not coerced to undefined')
    assert.equal(tool.toolRefKind, 'native')
    assert.equal(tool.toolMcpServerSlug, undefined)
  })

  it('maps MCP tool refs to shape=mcp + carries the server slug', () => {
    let state = run([
      {
        kind: 'sdk',
        message: claudeStream({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tu_m', name: 'mcp__figma__authenticate' }
        })
      }
    ])
    state = reduce(
      state,
      {
        kind: 'sdk',
        message: assistantMsg([mcpBlock('figma', 'authenticate', 'tu_m', { token: 'redacted' })])
      },
      ctx
    )
    const tool = state.messages.find((m) => m.id === 'tu_m')!
    assert.equal(tool.toolShape, 'mcp')
    assert.equal(tool.toolRefKind, 'mcp')
    assert.equal(tool.toolMcpServerSlug, 'figma')
  })
})

describe('reducer — task tools', () => {
  it('aggregates TaskCreate/TaskUpdate into a single task-list message', () => {
    let state = createInitialState(SID)
    state = reduce(
      state,
      { kind: 'sdk', message: assistantMsg([mcpToolUse('TaskCreate', 't1', { subject: 'A' })]) },
      ctx
    )
    state = reduce(
      state,
      { kind: 'sdk', message: assistantMsg([mcpToolUse('TaskCreate', 't2', { subject: 'B' })]) },
      ctx
    )
    state = reduce(
      state,
      {
        kind: 'sdk',
        message: assistantMsg([mcpToolUse('TaskUpdate', 't3', { taskId: '1', status: 'completed' })])
      },
      ctx
    )

    assert.equal(state.messages.length, 1)
    const list = state.messages[0]!
    assert.equal(list.type, 'task-list')
    assert.equal(list.tasks?.length, 2)
    assert.equal(list.tasks?.[0]?.status, 'completed')
    assert.equal(list.tasks?.[1]?.status, 'pending')
  })

  it('does not create a placeholder tool card for task tools during streaming', () => {
    const state = run([
      {
        kind: 'sdk',
        message: claudeStream({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 't1', name: 'mcp__jack__TaskCreate' }
        })
      }
    ])
    assert.equal(state.messages.length, 0)
  })
})

describe('reducer — slash commands and CLI markers', () => {
  it('renders a slash-command chip for envelope-shaped user messages (with ctx parser)', () => {
    const state = run(
      [{ kind: 'sdk', message: userMsg([textBlock('<command-name>clear</command-name>')]) }],
      slashCtx
    )
    assert.equal(state.messages.length, 1)
    const m = state.messages[0]!
    assert.equal(m.type, 'slash-command')
    assert.equal(m.commandName, 'clear')
  })

  it('emits no slash chip for envelope-shaped user blocks when no ctx parser is injected', () => {
    // With chat-core 0.5.0 the reducer is provider-agnostic: hosts
    // targeting Codex/Gemini omit the `parseSlashEnvelope` callback and
    // the reducer skips slash detection entirely. `applyUserMessage`
    // only emits chips on envelope match — plain user text from a `user`
    // SDK message (typically a tool_result echo) doesn't surface as a
    // chat bubble at all (live user prompts come through `user-prompt`).
    const state = run([
      { kind: 'sdk', message: userMsg([textBlock('<command-name>clear</command-name>')]) }
    ])
    assert.equal(state.messages.length, 0)
  })

  it('ignores text-only user messages that are pure CLI markers in history (with ctx isCliMarkerOnly)', () => {
    const history: NormalizedMessage[] = [
      userMsg([textBlock('<local-command-stdout>ok</local-command-stdout>')])
    ]
    const state = loadHistory(history, SID, slashCtx)
    assert.equal(state.messages.length, 0)
  })

  it('keeps marker-only history messages as plain user bubbles when no ctx isCliMarkerOnly is injected', () => {
    const history: NormalizedMessage[] = [
      userMsg([textBlock('<local-command-stdout>ok</local-command-stdout>')])
    ]
    const state = loadHistory(history, SID, ctx)
    // Without the filter, the reducer renders the raw text — Codex/Gemini
    // hosts that don't have CLI markers won't hit this case in practice;
    // this test pins the documented "no callback ⇒ pass through" semantics.
    assert.equal(state.messages.length, 1)
    assert.equal(state.messages[0]!.type, 'user')
    assert.equal(state.messages[0]!.content, '<local-command-stdout>ok</local-command-stdout>')
  })
})

describe('reducer — turn_result and session_state', () => {
  it('clears running flag and status on turn_result success', () => {
    let state = createInitialState(SID)
    state = { ...state, running: true, statusLabel: 'Thinking' }
    state = reduce(state, { kind: 'sdk', message: turnResultSuccess() }, ctx)
    assert.equal(state.running, false)
    assert.equal(state.statusLabel, null)
    assert.equal(state.messages.length, 0, 'success emits no result card')
  })

  it('emits a result card on non-success turn_result (max turns)', () => {
    const state = reduce(
      createInitialState(SID),
      { kind: 'sdk', message: turnResultError('error_max_turns') },
      ctx
    )
    assert.equal(state.messages.length, 1)
    assert.equal(state.messages[0]!.type, 'result')
    assert.equal(state.messages[0]!.content, 'Reached max turns')
  })

  it('emits a generic result card for arbitrary error subtypes', () => {
    const state = reduce(
      createInitialState(SID),
      { kind: 'sdk', message: turnResultError('quota_exceeded') },
      ctx
    )
    assert.equal(state.messages.length, 1)
    assert.equal(state.messages[0]!.content, 'Error: quota_exceeded')
  })

  it('maps session_state.running to Thinking, idle/requires_action to null', () => {
    let state = createInitialState(SID)
    state = reduce(state, { kind: 'sdk', message: sessionState('running') }, ctx)
    assert.equal(state.statusLabel, 'Thinking')
    state = reduce(state, { kind: 'sdk', message: sessionState('requires_action') }, ctx)
    assert.equal(state.statusLabel, null)
    state = reduce(state, { kind: 'sdk', message: sessionState('running') }, ctx)
    state = reduce(state, { kind: 'sdk', message: sessionState('idle') }, ctx)
    assert.equal(state.statusLabel, null)
  })
})

describe('reducer — permission and file-change', () => {
  it('inlines a pending-permission card when inlineFileDiff is present', () => {
    const state = reduce(
      createInitialState(SID),
      {
        kind: 'permission-request',
        data: {
          sessionId: SID,
          toolName: 'Edit',
          toolInput: {},
          cwd: '/tmp',
          toolUseID: 'perm_1',
          inlineFileDiff: { toolName: 'Edit', filePath: '/tmp/a.ts' }
        }
      },
      ctx
    )
    assert.equal(state.messages.length, 1)
    const m = state.messages[0]!
    assert.equal(m.id, 'perm_1')
    assert.equal(m.type, 'pending-permission')
  })

  it('replaces existing tool card with file-diff on file-change', () => {
    let state = run([
      {
        kind: 'sdk',
        message: claudeStream({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tu_x', name: 'Edit' }
        })
      }
    ])
    state = reduce(
      state,
      {
        kind: 'file-change',
        data: {
          toolName: 'Edit',
          toolUseId: 'tu_x',
          filePath: '/tmp/a.ts',
          originalFile: null,
          structuredPatch: []
        }
      },
      ctx
    )
    const m = state.messages.find((x) => x.id === 'tu_x')!
    assert.equal(m.type, 'file-diff')
    assert.equal(m.fileChange?.filePath, '/tmp/a.ts')
  })
})

describe('loadHistory', () => {
  it('replays a simple transcript into ordered bubbles', () => {
    const history: NormalizedMessage[] = [
      userMsg([textBlock('ciao')]),
      assistantMsg([
        textBlock('ok'),
        nativeToolUse('Read', 'fs.read', 'tu1', { file_path: '/f' })
      ])
    ]
    const state = loadHistory(history, SID, ctx)
    assert.equal(state.messages.length, 3)
    assert.equal(state.messages[0]!.type, 'user')
    assert.equal(state.messages[0]!.content, 'ciao')
    assert.equal(state.messages[1]!.type, 'assistant')
    assert.equal(state.messages[1]!.content, 'ok')
    assert.equal(state.messages[2]!.type, 'tool')
    assert.equal(state.messages[2]!.id, 'tu1')
    assert.equal(state.messages[2]!.toolName, 'Read')
    assert.deepEqual(state.messages[2]!.toolInput, { file_path: '/f' })
  })

  it('projects toolShape onto tool cards rebuilt from history (mcp)', () => {
    const history: NormalizedMessage[] = [
      userMsg([textBlock('do figma stuff')]),
      assistantMsg([
        textBlock('authenticating'),
        mcpBlock('figma', 'authenticate', 'tu_h', { token: 't' })
      ])
    ]
    const state = loadHistory(history, SID, ctx)
    const tool = state.messages.find((m) => m.type === 'tool')!
    assert.equal(tool.id, 'tu_h')
    assert.equal(tool.toolShape, 'mcp')
    assert.equal(tool.toolRefKind, 'mcp')
    assert.equal(tool.toolMcpServerSlug, 'figma')
    assert.equal(tool.toolName, 'mcp__figma__authenticate', 'history keeps the wire name as toolName for mcp')
  })

  it('projects toolShape onto tool cards rebuilt from history (native)', () => {
    const history: NormalizedMessage[] = [
      userMsg([textBlock('read it')]),
      assistantMsg([nativeToolUse('Read', 'fs.read', 'tu_r', { file_path: '/f' })])
    ]
    const state = loadHistory(history, SID, ctx)
    const tool = state.messages.find((m) => m.type === 'tool')!
    assert.equal(tool.toolShape, 'fs.read')
    assert.equal(tool.toolRefKind, 'native')
    assert.equal(tool.toolMcpServerSlug, undefined)
  })

  it('aggregates jack mcp task tools from history into a task-list message', () => {
    const history: NormalizedMessage[] = [
      userMsg([textBlock('do stuff')]),
      assistantMsg([
        textBlock('starting'),
        mcpToolUse('TaskCreate', 't1', { subject: 'A' }),
        mcpToolUse('TaskCreate', 't2', { subject: 'B' })
      ])
    ]
    const state = loadHistory(history, SID, ctx)
    // user 'do stuff' + assistant 'starting' + task-list aggregation
    assert.equal(state.messages.length, 3)
    const list = state.messages[2]!
    assert.equal(list.type, 'task-list')
    assert.equal(list.tasks?.length, 2)
  })
})

describe('reducer — slash-invocation', () => {
  it('appends a chip with name and args, bumping msgCounter', () => {
    const state = reduce(
      createInitialState(SID),
      { kind: 'slash-invocation', name: 'model', args: 'sonnet' },
      ctx
    )
    assert.equal(state.messages.length, 1)
    const m = state.messages[0]!
    assert.equal(m.type, 'slash-command')
    assert.equal(m.commandName, 'model')
    assert.equal(m.commandArgs, 'sonnet')
    assert.equal(state.msgCounter, 1)
    assert.equal(m.id, '1')
  })

  it('strips a leading / so client and envelope-origin chips match', () => {
    const state = reduce(
      createInitialState(SID),
      { kind: 'slash-invocation', name: '/clear' },
      ctx
    )
    assert.equal(state.messages[0]!.commandName, 'clear')
  })

  it('omits commandArgs when args is missing or empty', () => {
    const noArgs = reduce(
      createInitialState(SID),
      { kind: 'slash-invocation', name: 'help' },
      ctx
    )
    assert.equal('commandArgs' in noArgs.messages[0]!, false)

    const emptyArgs = reduce(
      createInitialState(SID),
      { kind: 'slash-invocation', name: 'help', args: '' },
      ctx
    )
    assert.equal('commandArgs' in emptyArgs.messages[0]!, false)
  })
})

describe('reducer — permission-resolved', () => {
  function seedPermission(): ReturnType<typeof createInitialState> {
    return reduce(
      createInitialState(SID),
      {
        kind: 'permission-request',
        data: {
          sessionId: SID,
          toolName: 'Edit',
          toolInput: {},
          cwd: '/tmp',
          toolUseID: 'perm_1',
          inlineFileDiff: { toolName: 'Edit', filePath: '/tmp/a.ts' }
        }
      },
      ctx
    )
  }

  it('removes the card on deny', () => {
    let state = seedPermission()
    // Add an unrelated message to confirm it survives.
    state = reduce(state, { kind: 'user-prompt', text: 'ciao' }, ctx)
    const before = state.messages.length
    state = reduce(
      state,
      { kind: 'permission-resolved', toolUseID: 'perm_1', decision: 'deny' },
      ctx
    )
    assert.equal(state.messages.length, before - 1)
    assert.equal(state.messages.find((m) => m.id === 'perm_1'), undefined)
    assert.ok(state.messages.find((m) => m.type === 'user' && m.content === 'ciao'))
  })

  it('marks streaming:true on allow without touching other messages', () => {
    let state = seedPermission()
    state = reduce(state, { kind: 'user-prompt', text: 'other' }, ctx)
    state = reduce(
      state,
      { kind: 'permission-resolved', toolUseID: 'perm_1', decision: 'allow' },
      ctx
    )
    const perm = state.messages.find((m) => m.id === 'perm_1')!
    assert.equal(perm.streaming, true)
    const user = state.messages.find((m) => m.type === 'user')!
    assert.notEqual(user.streaming, true)
  })

  it('is a no-op when toolUseID does not match any message', () => {
    const state = seedPermission()
    const after = reduce(
      state,
      { kind: 'permission-resolved', toolUseID: 'missing', decision: 'allow' },
      ctx
    )
    assert.equal(after.messages.length, state.messages.length)
    for (const m of after.messages) {
      assert.notEqual(m.streaming, true)
    }
  })
})

describe('reducer — interrupt', () => {
  it('resets running/status/streaming on active turn without dropping messages', () => {
    let state = run([
      {
        kind: 'sdk',
        message: claudeStream({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text' }
        })
      },
      {
        kind: 'sdk',
        message: claudeStream({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'working' }
        })
      }
    ])
    state = reduce(state, { kind: 'sdk', message: sessionState('running') }, ctx)

    assert.equal(state.running, true)
    assert.equal(state.statusLabel, 'Thinking')
    assert.ok(Object.keys(state.streamingBlocks).length > 0)
    assert.ok(state.currentAssistantId !== null)
    assert.equal(state.messages.some((m) => m.streaming === true), true)

    const before = state.messages.length
    const after = reduce(state, { kind: 'interrupt' }, ctx)

    assert.equal(after.running, false)
    assert.equal(after.statusLabel, null)
    assert.deepEqual(after.streamingBlocks, {})
    assert.equal(after.currentAssistantId, null)
    assert.equal(after.messages.length, before)
    for (const m of after.messages) {
      assert.notEqual(m.streaming, true)
    }
  })

  it('is idempotent on an already-idle state', () => {
    const idle = createInitialState(SID)
    const after = reduce(idle, { kind: 'interrupt' }, ctx)
    assert.equal(after.running, false)
    assert.equal(after.statusLabel, null)
    assert.deepEqual(after.streamingBlocks, {})
    assert.equal(after.currentAssistantId, null)
    assert.deepEqual(after.messages, idle.messages)
  })
})

describe('reducer — load-history action', () => {
  const history: NormalizedMessage[] = [
    userMsg([textBlock('ciao')]),
    assistantMsg([
      textBlock('ok'),
      nativeToolUse('Read', 'fs.read', 'tu1', { file_path: '/f' })
    ])
  ]

  it('produces the same state as a direct loadHistory() call', () => {
    const direct = loadHistory(history, SID, ctx)
    const viaDispatch = reduce(
      createInitialState(null),
      { kind: 'load-history', rawMessages: history, sessionId: SID },
      ctx
    )
    assert.deepEqual(viaDispatch, direct)
  })

  it('replaces a dirty state entirely (no merge)', () => {
    const dirty = run([
      {
        kind: 'sdk',
        message: claudeStream({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text' }
        })
      },
      {
        kind: 'sdk',
        message: claudeStream({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'streaming' }
        })
      },
      {
        kind: 'sdk',
        message: assistantMsg([mcpToolUse('TaskCreate', 't1', { subject: 'A' })])
      }
    ])

    assert.ok(dirty.messages.length > 0, 'precondition: dirty state has messages')
    assert.ok(Object.keys(dirty.streamingBlocks).length > 0, 'precondition: dirty state has active streaming blocks')
    assert.ok(dirty.currentAssistantId !== null, 'precondition: dirty state has a current assistant id')
    assert.ok(dirty.taskCounter > 0, 'precondition: dirty state has a non-zero task counter')

    const reset = reduce(
      dirty,
      { kind: 'load-history', rawMessages: history, sessionId: SID },
      ctx
    )

    assert.deepEqual(reset.streamingBlocks, {}, 'streamingBlocks cleared')
    assert.equal(reset.currentAssistantId, null, 'currentAssistantId cleared')
    assert.equal(reset.running, false, 'running cleared')
    assert.equal(reset.statusLabel, null, 'statusLabel cleared')
    assert.equal(reset.taskCounter, 0, 'taskCounter reset (history had no task tools)')
    assert.equal(reset.sessionId, SID)
    assert.equal(reset.messages.length, 3)
    assert.equal(reset.messages[0]!.content, 'ciao')
  })
})

describe('reducer — non-Claude partial_event payloads', () => {
  it('preserves state for partial_event payloads we cannot decode', () => {
    const before = createInitialState(SID)
    const after = reduce(
      before,
      { kind: 'sdk', message: { kind: 'partial_event', raw: { provider: 'codex', kind: 'token', text: 'hi' } } },
      ctx
    )
    assert.deepEqual(after, before)
  })
})

describe('reducer — agent-error', () => {
  it('appends an error result card and clears running flag and streaming bookkeeping', () => {
    let state = createInitialState(SID)
    state = { ...state, running: true, currentAssistantId: 'assistant-x' }
    state = reduce(state, { kind: 'agent-error', error: 'boom' }, ctx)
    assert.equal(state.running, false)
    assert.deepEqual(state.streamingBlocks, {})
    assert.equal(state.currentAssistantId, null)
    assert.equal(state.messages.length, 1)
    assert.equal(state.messages[0]!.type, 'result')
    assert.equal(state.messages[0]!.content, 'Error: boom')
  })
})

describe('reducer — turn-started dedup', () => {
  it('flips running:true without re-appending a duplicate user bubble', () => {
    let state = reduce(createInitialState(SID), { kind: 'user-prompt', text: 'hi' }, ctx)
    const before = state.messages.length
    state = { ...state, running: false }
    state = reduce(state, { kind: 'turn-started', text: 'hi' }, ctx)
    assert.equal(state.running, true)
    assert.equal(state.messages.length, before, 'no duplicate bubble appended')
  })

  it('appends a user bubble when no matching local prompt exists', () => {
    const state = reduce(
      createInitialState(SID),
      { kind: 'turn-started', text: 'remote prompt' },
      ctx
    )
    assert.equal(state.running, true)
    assert.equal(state.messages.length, 1)
    assert.equal(state.messages[0]!.type, 'user')
    assert.equal(state.messages[0]!.content, 'remote prompt')
  })
})

describe('reducer — context-usage', () => {
  it('appends a context-usage chip carrying the usage payload', () => {
    const usage = { totalTokens: 100, maxTokens: 200, percentage: 50 }
    const state = reduce(
      createInitialState(SID),
      { kind: 'context-usage', usage },
      ctx
    )
    assert.equal(state.messages.length, 1)
    const m = state.messages[0]!
    assert.equal(m.type, 'context-usage')
    assert.deepEqual(m.contextUsage, usage)
  })
})

describe('reducer — slash-feedback', () => {
  it('appends a slash-feedback chip with default ok status', () => {
    const state = reduce(
      createInitialState(SID),
      { kind: 'slash-feedback', text: 'switched' },
      ctx
    )
    assert.equal(state.messages.length, 1)
    assert.equal(state.messages[0]!.type, 'slash-feedback')
    assert.equal(state.messages[0]!.feedbackStatus, 'ok')
    assert.equal(state.messages[0]!.content, 'switched')
  })

  it('respects an explicit error status', () => {
    const state = reduce(
      createInitialState(SID),
      { kind: 'slash-feedback', text: 'failed', status: 'error' },
      ctx
    )
    assert.equal(state.messages[0]!.feedbackStatus, 'error')
  })
})

describe('reducer — tool_result error path', () => {
  it('marks the tool card as errored when isError is true', () => {
    let state = run([
      {
        kind: 'sdk',
        message: claudeStream({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tu_err', name: 'Bash' }
        })
      }
    ])
    state = reduce(
      state,
      { kind: 'sdk', message: userMsg([toolResult('tu_err', true, 'denied')]) },
      ctx
    )
    const tool = state.messages.find((m) => m.id === 'tu_err')!
    assert.equal(tool.toolStatus, 'error')
    assert.equal(tool.streaming, false)
  })
})
