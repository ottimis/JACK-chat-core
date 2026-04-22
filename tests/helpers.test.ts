import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  expandCommandBody,
  isCliMarkerOnly,
  isTaskTool,
  parseSlashEnvelope
} from '../src/helpers.js'

describe('parseSlashEnvelope', () => {
  it('parses a well-formed envelope with args and stdout', () => {
    const text =
      '<command-name>model</command-name>\n<command-args>sonnet</command-args>\n<local-command-stdout>switched\n</local-command-stdout>'
    const parsed = parseSlashEnvelope(text)
    assert.deepEqual(parsed, {
      commandName: 'model',
      commandArgs: 'sonnet',
      commandStdout: 'switched\n'
    })
  })

  it('parses a name-only envelope', () => {
    const parsed = parseSlashEnvelope('<command-name>clear</command-name>')
    assert.deepEqual(parsed, {
      commandName: 'clear',
      commandArgs: undefined,
      commandStdout: undefined
    })
  })

  it('returns null when the text is not an envelope', () => {
    assert.equal(parseSlashEnvelope('hello world'), null)
    assert.equal(parseSlashEnvelope(''), null)
  })

  it('tolerates leading whitespace', () => {
    const parsed = parseSlashEnvelope('   \n<command-name>help</command-name>')
    assert.equal(parsed?.commandName, 'help')
  })

  it('returns null when command name is empty', () => {
    assert.equal(parseSlashEnvelope('<command-name></command-name>'), null)
  })
})

describe('isCliMarkerOnly', () => {
  it('returns true when text is only envelope markers', () => {
    const text =
      '<command-name>clear</command-name><command-args></command-args><local-command-stdout>ok</local-command-stdout>'
    assert.equal(isCliMarkerOnly(text), true)
  })

  it('returns false when there is real user text alongside markers', () => {
    const text = '<command-name>ping</command-name>hello'
    assert.equal(isCliMarkerOnly(text), false)
  })

  it('returns false for ordinary prompts', () => {
    assert.equal(isCliMarkerOnly('please refactor the chat store'), false)
  })
})

describe('isTaskTool', () => {
  it('recognises task-family tools', () => {
    for (const name of ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']) {
      assert.equal(isTaskTool(name), true, `expected ${name} to be task tool`)
    }
  })

  it('rejects unrelated tool names', () => {
    assert.equal(isTaskTool('Edit'), false)
    assert.equal(isTaskTool(''), false)
    assert.equal(isTaskTool(undefined), false)
  })
})

describe('expandCommandBody', () => {
  const def = {
    name: 'demo',
    scope: 'user' as const,
    body: 'first=$1 all=$ARGUMENTS',
    filePath: '/tmp/demo.md'
  }

  it('substitutes positional and $ARGUMENTS', () => {
    assert.equal(expandCommandBody(def, 'one two three'), 'first=one all=one two three')
  })

  it('handles empty args', () => {
    assert.equal(expandCommandBody(def, ''), 'first= all=')
  })

  it('substitutes $N before $ARGUMENTS so literal $1 in args survives', () => {
    const def2 = { ...def, body: '$1 | $ARGUMENTS' }
    // raw arg "$1 foo" should expand: $1 → "$1", $ARGUMENTS → "$1 foo"
    assert.equal(expandCommandBody(def2, '$1 foo'), '$1 | $1 foo')
  })
})
