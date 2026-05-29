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
  thinkingBlock,
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

  it('appends text + thinking from final assistant when provider has no partial streaming', () => {
    // Codex shape: no `partial_event` flow, the whole turn arrives in a
    // single `assistant` NormalizedMessage. With the default ctx (Claude
    // semantics) the reducer would drop those text/thinking blocks; the
    // `providerHasPartialStreaming: false` flag opts the reducer into
    // appending them as a new bubble — same shape as `loadHistory`.
    const noStreamCtx: ReduceContext = {
      now: () => 1_000_000,
      providerHasPartialStreaming: false
    }
    const state = run(
      [{ kind: 'sdk', message: assistantMsg([thinkingBlock('let me think'), textBlock('Ciao')]) }],
      noStreamCtx
    )
    assert.equal(state.messages.length, 1)
    const m = state.messages[0]!
    assert.equal(m.type, 'assistant')
    assert.equal(m.content, 'Ciao')
    assert.equal(m.thinking, 'let me think')
  })

  it('does not double-append text when provider has partial streaming (default)', () => {
    // With Claude's flow the text already lives in the bubble built from
    // partial_event deltas; the final `assistant` message must NOT append
    // a second copy.
    const state = run([
      { kind: 'sdk', message: claudeStream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }) },
      { kind: 'sdk', message: claudeStream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }) },
      { kind: 'sdk', message: claudeStream({ type: 'content_block_stop', index: 0 }) },
      { kind: 'sdk', message: claudeStream({ type: 'message_stop' }) },
      { kind: 'sdk', message: assistantMsg([textBlock('Hello')]) }
    ])
    assert.equal(state.messages.length, 1)
    assert.equal(state.messages[0]!.content, 'Hello')
  })

  it('stamps assistant.model on the streaming row when final lands (Claude shape)', () => {
    // Regression: family-aliased model selections (`opus`, `sonnet`) get
    // resolved server-side to a concrete id (`claude-opus-4-8`). The host
    // needs that id to surface "what's actually running" in the Model
    // dropdown tooltip. The reducer copies it from the final assistant
    // envelope onto the streaming-built ChatMessage so the renderer can
    // read it without scanning provider-specific telemetry.
    const state = run([
      { kind: 'sdk', message: claudeStream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }) },
      { kind: 'sdk', message: claudeStream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }) },
      { kind: 'sdk', message: claudeStream({ type: 'content_block_stop', index: 0 }) },
      { kind: 'sdk', message: assistantMsg([textBlock('Hi')], { model: 'claude-opus-4-8' }) }
    ])
    assert.equal(state.messages.length, 1)
    assert.equal(state.messages[0]!.model, 'claude-opus-4-8')
  })

  it('stamps assistant.model on a fresh row for non-streaming providers (Codex shape)', () => {
    const noStreamCtx: ReduceContext = {
      now: () => 1_000_000,
      providerHasPartialStreaming: false
    }
    const state = run(
      [{ kind: 'sdk', message: assistantMsg([textBlock('Ciao')], { model: 'gpt-5-codex' }) }],
      noStreamCtx
    )
    assert.equal(state.messages.length, 1)
    assert.equal(state.messages[0]!.model, 'gpt-5-codex')
  })

  it('leaves assistant.model unset when the provider envelope omits it', () => {
    // Graceful degradation: Codex doesn't emit per-turn model today, so the
    // tooltip simply shows no "running" line. Reducer must not invent a
    // value or carry over a previous turn's model unrelated to this one.
    const state = run([
      { kind: 'sdk', message: claudeStream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }) },
      { kind: 'sdk', message: claudeStream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }) },
      { kind: 'sdk', message: claudeStream({ type: 'content_block_stop', index: 0 }) },
      { kind: 'sdk', message: assistantMsg([textBlock('Hi')]) }
    ])
    assert.equal(state.messages.length, 1)
    assert.equal(state.messages[0]!.model, undefined)
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

  it('aggregates native task tools (shape: task) into the same widget', () => {
    let state = createInitialState(SID)
    state = reduce(
      state,
      {
        kind: 'sdk',
        message: assistantMsg([nativeToolUse('TaskCreate', 'task', 'n1', { subject: 'A' })])
      },
      ctx
    )
    state = reduce(
      state,
      {
        kind: 'sdk',
        message: assistantMsg([nativeToolUse('TaskCreate', 'task', 'n2', { subject: 'B' })])
      },
      ctx
    )
    state = reduce(
      state,
      {
        kind: 'sdk',
        message: assistantMsg([
          nativeToolUse('TaskUpdate', 'task', 'n3', { taskId: '1', status: 'completed' })
        ])
      },
      ctx
    )
    state = reduce(
      state,
      {
        kind: 'sdk',
        message: assistantMsg([nativeToolUse('TaskDelete', 'task', 'n4', { taskId: '2' })])
      },
      ctx
    )

    assert.equal(state.messages.length, 1)
    const list = state.messages[0]!
    assert.equal(list.type, 'task-list')
    assert.equal(list.tasks?.length, 2)
    assert.equal(list.tasks?.[0]?.status, 'completed')
    assert.equal(list.tasks?.[1]?.status, 'deleted')
  })

  it('does not create a placeholder card for native task tools during streaming', () => {
    const state = run([
      {
        kind: 'sdk',
        message: claudeStream({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 't1', name: 'TaskCreate' }
        })
      }
    ])
    assert.equal(state.messages.length, 0)
  })

  it('discards input_json_delta deltas for task tools instead of spawning stray assistant bubbles', () => {
    const state = run([
      {
        kind: 'sdk',
        message: claudeStream({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 't1', name: 'TaskCreate' }
        })
      },
      {
        kind: 'sdk',
        message: claudeStream({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"subject":"A' }
        })
      },
      {
        kind: 'sdk',
        message: claudeStream({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: 'lpha"}' }
        })
      },
      {
        kind: 'sdk',
        message: claudeStream({ type: 'content_block_stop', index: 0 })
      }
    ])
    assert.equal(state.messages.length, 0)
  })
})

describe('reducer — userContentPolicy (provider-declared tag stripping)', () => {
  it('drops live user bubble whose text is fully wrapped in hidden tags', () => {
    const policyCtx: ReduceContext = {
      now: () => 1_000_000,
      userContentPolicy: { hiddenWrapperTags: ['environment_context'] }
    }
    const state = run(
      [
        {
          kind: 'sdk',
          message: userMsg([
            textBlock('<environment_context>\n  <cwd>/proj</cwd>\n</environment_context>')
          ])
        }
      ],
      policyCtx
    )
    // Body was nothing but the wrapped tag — bubble dropped, no slash chip,
    // no plain user message.
    assert.equal(state.messages.length, 0)
  })

  it('strips wrapped tags and keeps the rest of the user prompt visible (loadHistory)', () => {
    const policyCtx: ReduceContext = {
      now: () => 1_000_000,
      userContentPolicy: { hiddenWrapperTags: ['environment_context', 'jack-system'] }
    }
    const state = loadHistory(
      [
        userMsg([
          textBlock(
            '<environment_context>\n  <cwd>/proj</cwd>\n</environment_context>\n<jack-system>\nworkspace context here\n</jack-system>\n\nDo the thing.'
          )
        ])
      ],
      SID,
      policyCtx
    )
    // Wrappers stripped; the user's actual prompt remains as a single bubble.
    assert.equal(state.messages.length, 1)
    assert.equal(state.messages[0]!.type, 'user')
    assert.equal(state.messages[0]!.content, 'Do the thing.')
  })

  it('strips infoWrapperTags from text and attaches chips on the user bubble (loadHistory)', () => {
    const policyCtx: ReduceContext = {
      now: () => 1_000_000,
      userContentPolicy: {
        infoWrapperTags: [
          {
            tag: 'env',
            label: 'Env',
            chipKind: 'env',
            fields: [{ name: 'cwd', from: 'cwd' }]
          }
        ]
      }
    }
    const state = loadHistory(
      [userMsg([textBlock('<env><cwd>/proj</cwd></env>\n\nLook at this.')])],
      SID,
      policyCtx
    )
    assert.equal(state.messages.length, 1)
    const m = state.messages[0]!
    assert.equal(m.type, 'user')
    assert.equal(m.content, 'Look at this.')
    assert.ok(m.chips, 'expected chips to be attached')
    assert.equal(m.chips!.length, 1)
    assert.equal(m.chips![0]!.tag, 'env')
    assert.equal(m.chips![0]!.fields.cwd, '/proj')
  })

  it('emits a chip-only user bubble when infoWrapperTags fully consume the text (loadHistory)', () => {
    const policyCtx: ReduceContext = {
      now: () => 1_000_000,
      userContentPolicy: {
        infoWrapperTags: [
          {
            tag: 'task-notification',
            label: 'Background',
            chipKind: 'task',
            fields: [{ name: 'status', from: 'status' }]
          }
        ]
      }
    }
    const state = loadHistory(
      [
        userMsg([
          textBlock(
            '<task-notification><status>completed</status></task-notification>'
          )
        ])
      ],
      SID,
      policyCtx
    )
    assert.equal(state.messages.length, 1)
    const m = state.messages[0]!
    assert.equal(m.type, 'user')
    assert.equal(m.content, '')
    assert.equal(m.chips?.[0]?.fields.status, 'completed')
  })

  it('emits a chip-only user bubble live when info wrapper fully consumes the text (applyUserMessage)', () => {
    const policyCtx: ReduceContext = {
      now: () => 1_000_000,
      userContentPolicy: {
        infoWrapperTags: [
          {
            tag: 'task-notification',
            label: 'Background',
            chipKind: 'task',
            fields: [{ name: 'status', from: 'status' }]
          }
        ]
      }
    }
    const state = run(
      [
        {
          kind: 'sdk',
          message: userMsg([
            textBlock('<task-notification><status>completed</status></task-notification>')
          ])
        }
      ],
      policyCtx
    )
    assert.equal(state.messages.length, 1)
    const m = state.messages[0]!
    assert.equal(m.type, 'user')
    assert.equal(m.content, '')
    assert.equal(m.chips?.[0]?.fields.status, 'completed')
  })

  it('emits one chip per occurrence when the wrapper appears multiple times', () => {
    const policyCtx: ReduceContext = {
      now: () => 1_000_000,
      userContentPolicy: {
        infoWrapperTags: [
          {
            tag: 'task-notification',
            label: 'Background',
            chipKind: 'task',
            fields: [{ name: 'status', from: 'status' }]
          }
        ]
      }
    }
    const state = loadHistory(
      [
        userMsg([
          textBlock(
            '<task-notification><status>completed</status></task-notification>\n' +
              '<task-notification><status>failed</status></task-notification>'
          )
        ])
      ],
      SID,
      policyCtx
    )
    assert.equal(state.messages.length, 1)
    assert.equal(state.messages[0]!.chips?.length, 2)
    assert.equal(state.messages[0]!.chips?.[0]?.fields.status, 'completed')
    assert.equal(state.messages[0]!.chips?.[1]?.fields.status, 'failed')
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

  it('renders a clean "Stopped" card on the interrupted_by_user marker', () => {
    const state = reduce(
      createInitialState(SID),
      { kind: 'sdk', message: turnResultError('interrupted_by_user') },
      ctx
    )
    assert.equal(state.messages.length, 1)
    assert.equal(state.messages[0]!.type, 'result')
    assert.equal(state.messages[0]!.content, 'Stopped')
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

  it('preserves pending-permission across an out-of-order load-history', () => {
    // Race scenario from AgentChat: two parallel useEffects on session
    // mount dispatch `permission-request` (from pendingActions hydration)
    // and `load-history` (from agentGetMessages) in any order. The pending
    // must survive a later `load-history` — otherwise an inline approval
    // card that just landed gets wiped and the user has no UI to approve
    // (PermissionCard floater is suppressed for the active session).
    let state = createInitialState(SID)
    state = reduce(
      state,
      {
        kind: 'permission-request',
        data: {
          sessionId: SID,
          toolName: 'Edit',
          toolInput: {},
          cwd: '/tmp',
          toolUseID: 'perm_late',
          inlineFileDiff: { toolName: 'Edit', filePath: '/tmp/a.ts' }
        }
      },
      ctx
    )
    assert.equal(state.messages.length, 1)
    assert.equal(state.messages[0]!.type, 'pending-permission')

    // Later: load-history arrives with the past transcript (no pending in it).
    const history: NormalizedMessage[] = [
      userMsg([textBlock('ciao')]),
      assistantMsg([textBlock('ok')])
    ]
    state = reduce(state, { kind: 'load-history', rawMessages: history, sessionId: SID }, ctx)

    // History bubbles AND the pending card both present, pending last.
    assert.equal(state.messages.length, 3)
    assert.equal(state.messages[0]!.type, 'user')
    assert.equal(state.messages[1]!.type, 'assistant')
    const tail = state.messages[2]!
    assert.equal(tail.type, 'pending-permission')
    assert.equal(tail.id, 'perm_late')
  })

  it('preserves live state when load-history fires with an empty transcript (first-turn race)', () => {
    // Race scenario from AgentChat on a fresh session:
    // 1. User dispatches `user-prompt` → optimistic bubble + running=true.
    // 2. Provider emits `system/init` → host broadcasts session-id-assigned.
    // 3. The host's history-load effect re-runs (deps include the new
    //    provider session id), fetches an empty transcript (fresh session,
    //    nothing committed yet) and dispatches `load-history` with
    //    rawMessages=[]. Before the fix this wiped the optimistic user
    //    bubble until the SDK wire echoed the user message back — the
    //    visible "first message disappears until response" bug.
    let state = createInitialState(SID)
    state = reduce(state, { kind: 'user-prompt', text: 'ciao' }, ctx)
    assert.equal(state.messages.length, 1)
    assert.equal(state.messages[0]!.type, 'user')
    assert.equal(state.running, true)

    state = reduce(state, { kind: 'load-history', rawMessages: [], sessionId: SID }, ctx)

    // Optimistic bubble and running flag survive.
    assert.equal(state.messages.length, 1)
    const u = state.messages[0]!
    assert.equal(u.type, 'user')
    assert.equal(u.type === 'user' ? u.content : null, 'ciao')
    assert.equal(state.running, true)
  })

  it('still resets to empty when both state and history are empty', () => {
    // Sanity: the empty-history guard must NOT trigger when there's
    // nothing to preserve — otherwise a `load-history` with no transcript
    // on a brand-new state would short-circuit and skip session id
    // assignment / counter init that `loadHistory()` performs.
    let state = createInitialState(SID)
    state = reduce(state, { kind: 'load-history', rawMessages: [], sessionId: SID }, ctx)
    assert.equal(state.messages.length, 0)
    assert.equal(state.sessionId, SID)
  })

  it('does not duplicate a pending when history already contains a message with the same id', () => {
    // Defensive: a future provider could persist the tool_use with the
    // same id as the pending's toolUseID. Re-injecting would create two
    // visible cards with the same id. The carry-over filter dedupes.
    let state = createInitialState(SID)
    state = reduce(
      state,
      {
        kind: 'permission-request',
        data: {
          sessionId: SID,
          toolName: 'Edit',
          toolInput: {},
          cwd: '/tmp',
          toolUseID: 'tu_dup',
          inlineFileDiff: { toolName: 'Edit', filePath: '/tmp/a.ts' }
        }
      },
      ctx
    )
    const history: NormalizedMessage[] = [
      assistantMsg([nativeToolUse('Edit', 'fs.edit', 'tu_dup', { file_path: '/tmp/a.ts' })])
    ]
    state = reduce(state, { kind: 'load-history', rawMessages: history, sessionId: SID }, ctx)
    const dupCount = state.messages.filter((m) => m.id === 'tu_dup').length
    assert.equal(dupCount, 1)
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

  it('aggregates native task tools from history into a task-list message', () => {
    const history: NormalizedMessage[] = [
      userMsg([textBlock('do stuff')]),
      assistantMsg([
        textBlock('starting'),
        nativeToolUse('TaskCreate', 'task', 't1', { subject: 'A' }),
        nativeToolUse('TaskCreate', 'task', 't2', { subject: 'B' }),
        nativeToolUse('TaskUpdate', 'task', 't3', { taskId: '2', status: 'in_progress' })
      ])
    ]
    const state = loadHistory(history, SID, ctx)
    assert.equal(state.messages.length, 3)
    const list = state.messages[2]!
    assert.equal(list.type, 'task-list')
    assert.equal(list.tasks?.length, 2)
    assert.equal(list.tasks?.[1]?.status, 'in_progress')
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

describe('reducer — providerMessageId propagation', () => {
  // Why this matters: BranchFromHereButton in the desktop renderer passes
  // the chat row's id to the provider's `forkSession({ upToMessageId })`,
  // but row ids are a synthetic counter. Without surfacing the provider's
  // own transcript id (Claude JSONL `uuid`, Codex `item.id`) on the row,
  // forkSession can't find the cutoff and silently throws "Cutoff message
  // not found". These tests pin the carry-over for both live and replay.
  it('carries messageId onto a chip-bearing live user bubble', () => {
    // Single text block with both an info-wrapper occurrence and surrounding
    // text. After stripping the wrapper the cleaned text remains, so
    // applyUserMessage takes the `chips.length > 0 && cleaned` branch and
    // emits one chip-bearing user bubble.
    const policy = {
      infoWrapperTags: [
        { tag: 'task-notification', label: 'task', chipKind: 'task' as const }
      ]
    }
    const live = run(
      [
        {
          kind: 'sdk',
          message: userMsg(
            [textBlock('hello <task-notification>done</task-notification> world')],
            { messageId: 'claude-uuid-live-1' }
          )
        }
      ],
      { ...ctx, userContentPolicy: policy }
    )
    const userBubbles = live.messages.filter((m) => m.type === 'user')
    assert.equal(userBubbles.length, 1)
    assert.equal(userBubbles[0]!.providerMessageId, 'claude-uuid-live-1')
    assert.equal(userBubbles[0]!.chips?.length, 1)
  })

  it('carries messageId onto a chip-only live user bubble (text fully stripped)', () => {
    // Single text block entirely consumed by the info-wrapper. Cleaned text
    // is empty → applyUserMessage routes through chipBlobs and emits a
    // chip-only user bubble at the end. providerMessageId must follow.
    const policy = {
      infoWrapperTags: [
        { tag: 'task-notification', label: 'task', chipKind: 'task' as const }
      ]
    }
    const live = run(
      [
        {
          kind: 'sdk',
          message: userMsg(
            [textBlock('<task-notification>done</task-notification>')],
            { messageId: 'claude-uuid-chip-only' }
          )
        }
      ],
      { ...ctx, userContentPolicy: policy }
    )
    const userBubbles = live.messages.filter((m) => m.type === 'user')
    assert.equal(userBubbles.length, 1)
    assert.equal(userBubbles[0]!.content, '')
    assert.equal(userBubbles[0]!.providerMessageId, 'claude-uuid-chip-only')
  })

  it('carries messageId from a slash-envelope user echo onto the slash-command row', () => {
    const state = run(
      [
        {
          kind: 'sdk',
          message: userMsg(
            [textBlock('<command-name>review</command-name><command-args>HEAD</command-args>')],
            { messageId: 'claude-uuid-slash-2' }
          )
        }
      ],
      slashCtx
    )
    const slash = state.messages.find((m) => m.type === 'slash-command')!
    assert.equal(slash.commandName, 'review')
    assert.equal(slash.providerMessageId, 'claude-uuid-slash-2')
  })

  it('carries messageId through loadHistory replay onto the user bubble', () => {
    const history: NormalizedMessage[] = [
      userMsg([textBlock('ciao')], { messageId: 'claude-uuid-history-3' }),
      assistantMsg([textBlock('ok')])
    ]
    const state = loadHistory(history, SID, ctx)
    const user = state.messages.find((m) => m.type === 'user')!
    assert.equal(user.content, 'ciao')
    assert.equal(user.providerMessageId, 'claude-uuid-history-3')
  })

  it('leaves providerMessageId undefined for locally-originated user-prompt bubbles', () => {
    // user-prompt is the optimistic local echo dispatched by the desktop
    // before the wire roundtrip lands the kind: 'user' event. The fork
    // button must disable for these rows until the roundtrip populates the
    // provider id.
    const state = run([{ kind: 'user-prompt', text: 'optimistic' }])
    const user = state.messages.find((m) => m.type === 'user')!
    assert.equal(user.content, 'optimistic')
    assert.equal(user.providerMessageId, undefined)
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
