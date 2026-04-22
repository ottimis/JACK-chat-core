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

  it('is a no-op for TaskList / TaskGet', () => {
    const initial: ChatMessage[] = []
    const r1 = applyTaskTool(initial, sessionId, 'TaskList', {}, 0, NOW)
    const r2 = applyTaskTool(initial, sessionId, 'TaskGet', {}, 0, NOW)
    assert.equal(r1.messages, initial)
    assert.equal(r2.messages, initial)
    assert.equal(r1.taskCounter, 0)
  })

  it('is a no-op for TaskUpdate with unknown taskId', () => {
    const step1 = applyTaskTool([], sessionId, 'TaskCreate', { subject: 'A' }, 0, NOW)
    const step2 = applyTaskTool(step1.messages, sessionId, 'TaskUpdate', { taskId: '99' }, step1.taskCounter, NOW + 1)
    assert.equal(step2.messages, step1.messages)
  })
})
