import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createInitialState, reduce, loadHistory } from '../src/reducer.js'
import type { AgentEvent, SdkMessage } from '../src/types.js'

const SID = 'session-1'
const ctx = { now: () => 1_000_000 }

function run(events: AgentEvent[]) {
  let state = createInitialState(SID)
  for (const ev of events) state = reduce(state, ev, ctx)
  return state
}

describe('reducer — streaming assistant turn', () => {
  it('builds a single assistant bubble from thinking + text deltas', () => {
    const state = run([
      { kind: 'sdk', message: { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } } },
      { kind: 'sdk', message: { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm ' } } } },
      { kind: 'sdk', message: { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'let me see' } } } },
      { kind: 'sdk', message: { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } } },
      { kind: 'sdk', message: { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } } } },
      { kind: 'sdk', message: { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello ' } } } },
      { kind: 'sdk', message: { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'world' } } } },
      { kind: 'sdk', message: { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } } },
      { kind: 'sdk', message: { type: 'stream_event', event: { type: 'message_stop' } } }
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
      { kind: 'sdk', message: { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } } },
      { kind: 'sdk', message: { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'checking...' } } } },
      { kind: 'sdk', message: { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'Read' } } } }
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
      { kind: 'sdk', message: { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'Read' } } } },
      { kind: 'sdk', message: { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } } },
      { kind: 'sdk', message: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/foo' } }] } } }
    ])
    state = reduce(
      state,
      {
        kind: 'sdk',
        message: {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: false }] }
        }
      },
      ctx
    )
    const tool = state.messages.find((m) => m.id === 'tu_1')!
    assert.equal(tool.toolStatus, 'done')
    assert.deepEqual(tool.toolInput, { file_path: '/foo' })
  })
})

describe('reducer — task tools', () => {
  it('aggregates TaskCreate/TaskUpdate into a single task-list message', () => {
    let state = createInitialState(SID)
    state = reduce(
      state,
      {
        kind: 'sdk',
        message: {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 't1', name: 'TaskCreate', input: { subject: 'A' } }] }
        }
      },
      ctx
    )
    state = reduce(
      state,
      {
        kind: 'sdk',
        message: {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 't2', name: 'TaskCreate', input: { subject: 'B' } }] }
        }
      },
      ctx
    )
    state = reduce(
      state,
      {
        kind: 'sdk',
        message: {
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 't3', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } }]
          }
        }
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
        message: {
          type: 'stream_event',
          event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'TaskCreate' } }
        }
      }
    ])
    assert.equal(state.messages.length, 0)
  })
})

describe('reducer — slash commands and CLI markers', () => {
  it('renders a slash-command chip for envelope-shaped user messages', () => {
    const state = run([
      {
        kind: 'sdk',
        message: {
          type: 'user',
          message: { content: [{ type: 'text', text: '<command-name>clear</command-name>' }] }
        }
      }
    ])
    assert.equal(state.messages.length, 1)
    const m = state.messages[0]!
    assert.equal(m.type, 'slash-command')
    assert.equal(m.commandName, 'clear')
  })

  it('ignores text-only user messages that are pure CLI markers in history', () => {
    const history: SdkMessage[] = [
      { type: 'user', message: { content: [{ type: 'text', text: '<local-command-stdout>ok</local-command-stdout>' }] } }
    ]
    const state = loadHistory(history, SID, ctx)
    assert.equal(state.messages.length, 0)
  })
})

describe('reducer — result and system', () => {
  it('clears running flag and status on result:success', () => {
    let state = createInitialState(SID)
    state = { ...state, running: true, statusLabel: 'Thinking' }
    state = reduce(state, { kind: 'sdk', message: { type: 'result', subtype: 'success' } }, ctx)
    assert.equal(state.running, false)
    assert.equal(state.statusLabel, null)
    assert.equal(state.messages.length, 0, 'success emits no result card')
  })

  it('emits a result card on non-success result', () => {
    const state = reduce(
      createInitialState(SID),
      { kind: 'sdk', message: { type: 'result', subtype: 'error_max_turns' } },
      ctx
    )
    assert.equal(state.messages.length, 1)
    assert.equal(state.messages[0]!.type, 'result')
    assert.equal(state.messages[0]!.content, 'Reached max turns')
  })

  it('maps system:status to statusLabel', () => {
    let state = createInitialState(SID)
    state = reduce(state, { kind: 'sdk', message: { type: 'system', subtype: 'status', status: 'requesting' } }, ctx)
    assert.equal(state.statusLabel, 'Thinking')
    state = reduce(state, { kind: 'sdk', message: { type: 'system', subtype: 'status', status: 'compacting' } }, ctx)
    assert.equal(state.statusLabel, 'Compacting')
    state = reduce(state, { kind: 'sdk', message: { type: 'system', subtype: 'status', status: null } }, ctx)
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
        message: {
          type: 'stream_event',
          event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_x', name: 'Edit' } }
        }
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
    const history: SdkMessage[] = [
      { type: 'user', message: { content: 'ciao' } },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'ok' },
            { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/f' } }
          ]
        }
      }
    ]
    const state = loadHistory(history, SID, ctx)
    assert.equal(state.messages.length, 3)
    assert.equal(state.messages[0]!.type, 'user')
    assert.equal(state.messages[0]!.content, 'ciao')
    assert.equal(state.messages[1]!.type, 'assistant')
    assert.equal(state.messages[1]!.content, 'ok')
    assert.equal(state.messages[2]!.type, 'tool')
    assert.equal(state.messages[2]!.id, 'tu1')
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
    // No message gained a streaming flag.
    for (const m of after.messages) {
      assert.notEqual(m.streaming, true)
    }
  })
})

describe('reducer — interrupt', () => {
  it('resets running/status/streaming on active turn without dropping messages', () => {
    // Build an active state: streaming text bubble + a system status.
    let state = run([
      {
        kind: 'sdk',
        message: {
          type: 'stream_event',
          event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } }
        }
      },
      {
        kind: 'sdk',
        message: {
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'working' } }
        }
      }
    ])
    state = reduce(
      state,
      { kind: 'sdk', message: { type: 'system', subtype: 'status', status: 'requesting' } },
      ctx
    )

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
  const history: SdkMessage[] = [
    { type: 'user', message: { content: 'ciao' } },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'ok' },
          { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/f' } }
        ]
      }
    }
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
        message: {
          type: 'stream_event',
          event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } }
        }
      },
      {
        kind: 'sdk',
        message: {
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'streaming' } }
        }
      },
      {
        kind: 'sdk',
        message: {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 't1', name: 'TaskCreate', input: { subject: 'A' } }] }
        }
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
