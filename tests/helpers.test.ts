import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isTaskTool, isJackTaskTool } from '../src/helpers.js'
import type { NormalizedToolRef } from '../src/normalized.js'

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
