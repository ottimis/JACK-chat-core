import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyUserContentPolicy,
  extractInfoChips,
  isTaskTool,
  isJackTaskTool,
  stripWrapperTags
} from '../src/helpers.js'
import type { NormalizedToolRef } from '../src/normalized.js'
import type { ProviderUserContentPolicy } from '../src/types.js'

describe('isTaskTool (deprecated)', () => {
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

describe('isJackTaskTool', () => {
  function ref(kind: 'native' | 'mcp', name: string, slug = 'jack'): NormalizedToolRef {
    if (kind === 'native') {
      return { kind: 'native', toolName: name, shape: 'unknown', raw: name }
    }
    return { kind: 'mcp', serverSlug: slug, toolName: name, raw: `mcp__${slug}__${name}` }
  }

  it('matches mcp__jack__Task* tools', () => {
    assert.equal(isJackTaskTool(ref('mcp', 'TaskCreate')), true)
    assert.equal(isJackTaskTool(ref('mcp', 'TaskUpdate')), true)
    assert.equal(isJackTaskTool(ref('mcp', 'TaskList')), true)
    assert.equal(isJackTaskTool(ref('mcp', 'TaskGet')), true)
  })

  it('rejects mcp tools from other servers even if the name matches', () => {
    assert.equal(isJackTaskTool(ref('mcp', 'TaskCreate', 'other')), false)
  })

  it('rejects native tools that happen to share a name', () => {
    assert.equal(isJackTaskTool(ref('native', 'TaskCreate')), false)
  })

  it('rejects unrelated mcp tools', () => {
    assert.equal(isJackTaskTool(ref('mcp', 'authenticate', 'figma')), false)
  })
})

describe('stripWrapperTags', () => {
  it('returns input unchanged when no tags declared', () => {
    assert.equal(stripWrapperTags('hello <foo>bar</foo>', []), 'hello <foo>bar</foo>')
    assert.equal(stripWrapperTags('hello', undefined), 'hello')
  })

  it('strips a single declared tag block', () => {
    assert.equal(stripWrapperTags('a <env>x</env> b', ['env']), 'a  b'.trim())
  })

  it('strips multiple declared tags non-greedily', () => {
    assert.equal(
      stripWrapperTags('<a>x</a> middle <b>y</b>', ['a', 'b']),
      'middle'
    )
  })

  it('handles multi-line bodies', () => {
    assert.equal(
      stripWrapperTags('<foo>\n  line1\n  line2\n</foo>\nrest', ['foo']),
      'rest'
    )
  })

  it('escapes regex metachars in tag names', () => {
    // `.` and `*` would match anything in a naive regex; we escape them so
    // a tag name like `a.b` only matches literally.
    assert.equal(stripWrapperTags('<a.b>x</a.b>', ['a.b']), '')
    assert.equal(stripWrapperTags('<aab>x</aab>', ['a.b']), '<aab>x</aab>')
  })
})

describe('extractInfoChips', () => {
  const policy: ProviderUserContentPolicy = {
    infoWrapperTags: [
      {
        tag: 'task-notification',
        label: 'Background command',
        chipKind: 'task',
        fields: [
          { name: 'status', from: 'status' },
          { name: 'toolUseId', from: 'tool-use-id' },
          { name: 'summary', from: 'summary' },
          { name: 'outputFile', from: 'output-file' }
        ]
      }
    ]
  }

  it('returns [] when policy has no infoWrapperTags', () => {
    assert.deepEqual(extractInfoChips('<env>x</env>', undefined), [])
    assert.deepEqual(extractInfoChips('<env>x</env>', {}), [])
    assert.deepEqual(extractInfoChips('<env>x</env>', { hiddenWrapperTags: ['env'] }), [])
  })

  it('returns [] when text is empty', () => {
    assert.deepEqual(extractInfoChips('', policy), [])
  })

  it('extracts a single chip with declared fields', () => {
    const input = `
<task-notification>
<task-id>bt4zuqfjd</task-id>
<tool-use-id>toolu_01FcJYWVEWTLHZNnSSKHNtXg</tool-use-id>
<output-file>/private/tmp/claude/abc/tasks/bt4zuqfjd.output</output-file>
<status>completed</status>
<summary>Background command "find tsx" completed (exit code 0)</summary>
</task-notification>
    `.trim()
    const chips = extractInfoChips(input, policy)
    assert.equal(chips.length, 1)
    const c = chips[0]!
    assert.equal(c.tag, 'task-notification')
    assert.equal(c.label, 'Background command')
    assert.equal(c.chipKind, 'task')
    assert.equal(c.fields.status, 'completed')
    assert.equal(c.fields.toolUseId, 'toolu_01FcJYWVEWTLHZNnSSKHNtXg')
    assert.equal(c.fields.outputFile, '/private/tmp/claude/abc/tasks/bt4zuqfjd.output')
    assert.match(c.fields.summary!, /find tsx/)
  })

  it('extracts multiple occurrences of the same wrapper', () => {
    const input =
      '<task-notification><status>completed</status></task-notification>\n' +
      '<task-notification><status>failed</status></task-notification>'
    const chips = extractInfoChips(input, policy)
    assert.equal(chips.length, 2)
    assert.equal(chips[0]!.fields.status, 'completed')
    assert.equal(chips[1]!.fields.status, 'failed')
  })

  it('omits absent fields gracefully (partial body)', () => {
    const input = '<task-notification><status>completed</status></task-notification>'
    const chips = extractInfoChips(input, policy)
    assert.equal(chips.length, 1)
    assert.equal(chips[0]!.fields.status, 'completed')
    assert.equal(chips[0]!.fields.summary, undefined)
    assert.equal(chips[0]!.fields.toolUseId, undefined)
  })

  it('preserves raw inner body trimmed', () => {
    const input = '<task-notification>\n  <status>ok</status>\n</task-notification>'
    const chips = extractInfoChips(input, policy)
    assert.match(chips[0]!.raw, /^<status>ok<\/status>$/)
  })

  it('handles wrappers without declared fields (free-form body)', () => {
    const freeForm: ProviderUserContentPolicy = {
      infoWrapperTags: [{ tag: 'env', label: 'Env', chipKind: 'env' }]
    }
    const chips = extractInfoChips('<env>cwd=/proj user=root</env>', freeForm)
    assert.equal(chips.length, 1)
    assert.deepEqual(chips[0]!.fields, {})
    assert.equal(chips[0]!.raw, 'cwd=/proj user=root')
  })

  it('escapes regex metachars in tag and field names', () => {
    const evil: ProviderUserContentPolicy = {
      infoWrapperTags: [
        { tag: 'a.b', label: 'AB', fields: [{ name: 'x', from: 'c.d' }] }
      ]
    }
    const chips = extractInfoChips('<a.b><c.d>v</c.d></a.b>', evil)
    assert.equal(chips.length, 1)
    assert.equal(chips[0]!.fields.x, 'v')
    // The literal escape works: <aab>...</aab> shouldn't match <a.b>.
    assert.deepEqual(extractInfoChips('<aab>x</aab>', evil), [])
  })
})

describe('applyUserContentPolicy + extractInfoChips interaction', () => {
  const policy: ProviderUserContentPolicy = {
    hiddenWrapperTags: ['jack-system'],
    infoWrapperTags: [
      {
        tag: 'task-notification',
        label: 'Task',
        chipKind: 'task',
        fields: [{ name: 'status', from: 'status' }]
      }
    ]
  }

  it('strips both hidden and info wrappers from visible text', () => {
    const input =
      '<jack-system>boilerplate</jack-system>\n' +
      '<task-notification><status>ok</status></task-notification>\n' +
      'Real prose.'
    assert.equal(applyUserContentPolicy(input, policy), 'Real prose.')
  })

  it('extractInfoChips reads from raw text (before strip) — chips survive', () => {
    const input = '<task-notification><status>ok</status></task-notification>\nRest.'
    const chips = extractInfoChips(input, policy)
    assert.equal(chips.length, 1)
    assert.equal(chips[0]!.fields.status, 'ok')
    // And the visible text is the residual.
    assert.equal(applyUserContentPolicy(input, policy), 'Rest.')
  })
})
