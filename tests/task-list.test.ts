import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyTaskTool } from '../src/task-list.js'
import type { ChatMessage } from '../src/types.js'

describe('applyTaskTool', () => {
  const sessionId = 'abc'
  const NOW = 1000

  it('creates the task-list message on first TaskCreate', () => {
    const result = applyTaskTool([], sessionId, 'TaskCreate', { subject: 'Write tests' }, 0, NOW)
    assert.equal(result.taskCounter, 1)
    assert.equal(result.messages.length, 1)
    const list = result.messages[0]!
    assert.equal(list.id, `task-list-${sessionId}`)
    assert.equal(list.type, 'task-list')
    assert.equal(list.tasks?.length, 1)
    assert.deepEqual(list.tasks?.[0], {
      id: '1',
      subject: 'Write tests',
      status: 'pending',
      createdAt: NOW,
      updatedAt: NOW
    })
  })

  it('appends to an existing task-list on subsequent TaskCreate', () => {
    const step1 = applyTaskTool([], sessionId, 'TaskCreate', { subject: 'A' }, 0, NOW)
    const step2 = applyTaskTool(step1.messages, sessionId, 'TaskCreate', { subject: 'B' }, step1.taskCounter, NOW + 1)
    assert.equal(step2.messages.length, 1, 'still a single list message')
    assert.equal(step2.messages[0]!.tasks?.length, 2)
    assert.equal(step2.taskCounter, 2)
  })

  it('updates existing task on TaskUpdate by taskId', () => {
    const step1 = applyTaskTool([], sessionId, 'TaskCreate', { subject: 'A' }, 0, NOW)
    const step2 = applyTaskTool(
      step1.messages,
      sessionId,
      'TaskUpdate',
      { taskId: '1', status: 'in_progress' },
      step1.taskCounter,
      NOW + 1
    )
    assert.equal(step2.messages[0]!.tasks?.[0]?.status, 'in_progress')
    assert.equal(step2.messages[0]!.tasks?.[0]?.updatedAt, NOW + 1)
  })

  it('is a no-op for read-only / runtime task tools', () => {
    const initial: ChatMessage[] = []
    for (const tool of ['TaskList', 'TaskGet', 'TaskStop', 'TaskOutput']) {
      const r = applyTaskTool(initial, sessionId, tool, {}, 0, NOW)
      assert.equal(r.messages, initial, `${tool} should not mutate messages`)
      assert.equal(r.taskCounter, 0, `${tool} should not bump counter`)
    }
  })

  it('marks a task as deleted on TaskDelete', () => {
    const step1 = applyTaskTool([], sessionId, 'TaskCreate', { subject: 'A' }, 0, NOW)
    const step2 = applyTaskTool(
      step1.messages,
      sessionId,
      'TaskDelete',
      { taskId: '1' },
      step1.taskCounter,
      NOW + 1
    )
    assert.equal(step2.messages[0]!.tasks?.length, 1, 'entry stays for audit trail')
    assert.equal(step2.messages[0]!.tasks?.[0]?.status, 'deleted')
    assert.equal(step2.messages[0]!.tasks?.[0]?.updatedAt, NOW + 1)
    assert.equal(step2.taskCounter, step1.taskCounter)
  })

  it('is a no-op for TaskDelete with unknown taskId', () => {
    const step1 = applyTaskTool([], sessionId, 'TaskCreate', { subject: 'A' }, 0, NOW)
    const step2 = applyTaskTool(
      step1.messages,
      sessionId,
      'TaskDelete',
      { taskId: '99' },
      step1.taskCounter,
      NOW + 1
    )
    assert.equal(step2.messages, step1.messages)
  })

  it('is a no-op for TaskUpdate with unknown taskId', () => {
    const step1 = applyTaskTool([], sessionId, 'TaskCreate', { subject: 'A' }, 0, NOW)
    const step2 = applyTaskTool(step1.messages, sessionId, 'TaskUpdate', { taskId: '99' }, step1.taskCounter, NOW + 1)
    assert.equal(step2.messages, step1.messages)
  })
})
