import { pickStr } from './helpers.js'
import type { ChatMessage, TaskItem } from './types.js'

/**
 * Apply a TaskCreate / TaskUpdate / TaskDelete tool_use to the session's
 * aggregated task-list message. Returns an updated messages array (and
 * the task counter after any creations).
 *
 * Read-only or runtime-only tools (`TaskList`, `TaskGet`, `TaskStop`,
 * `TaskOutput`) are no-ops — they don't mutate the visible list. The
 * task entries themselves still appear in the aggregated widget via
 * earlier `TaskCreate` / `TaskUpdate` events.
 */
export function applyTaskTool(
  messages: ChatMessage[],
  sessionId: string,
  toolName: string,
  input: Record<string, unknown> | undefined,
  taskCounter: number,
  now: number = Date.now()
): { messages: ChatMessage[]; taskCounter: number } {
  const listId = `task-list-${sessionId}`
  const existingIndex = messages.findIndex((m) => m.id === listId)
  const existingList = existingIndex >= 0 ? messages[existingIndex] : null
  const tasks: TaskItem[] = existingList?.tasks ? [...existingList.tasks] : []
  let nextCounter = taskCounter

  if (toolName === 'TaskCreate') {
    const subject = pickStr(input, 'subject') ?? '(untitled)'
    const description = pickStr(input, 'description')
    const activeForm = pickStr(input, 'activeForm')
    nextCounter += 1
    tasks.push({
      id: String(nextCounter),
      subject,
      ...(description !== undefined ? { description } : {}),
      ...(activeForm !== undefined ? { activeForm } : {}),
      status: 'pending',
      createdAt: now,
      updatedAt: now
    })
  } else if (toolName === 'TaskUpdate') {
    const taskId = pickStr(input, 'taskId')
    if (!taskId) return { messages, taskCounter }
    const idx = tasks.findIndex((t) => t.id === taskId)
    if (idx < 0) return { messages, taskCounter }
    const current = tasks[idx]!
    const patch = input ?? {}
    tasks[idx] = {
      ...current,
      subject: pickStr(patch, 'subject') ?? current.subject,
      description: pickStr(patch, 'description') ?? current.description,
      activeForm: pickStr(patch, 'activeForm') ?? current.activeForm,
      status: (pickStr(patch, 'status') as TaskItem['status']) ?? current.status,
      updatedAt: now
    }
  } else if (toolName === 'TaskDelete') {
    const taskId = pickStr(input, 'taskId')
    if (!taskId) return { messages, taskCounter }
    const idx = tasks.findIndex((t) => t.id === taskId)
    if (idx < 0) return { messages, taskCounter }
    const current = tasks[idx]!
    tasks[idx] = { ...current, status: 'deleted', updatedAt: now }
  } else {
    // TaskList / TaskGet / TaskStop / TaskOutput — no-op
    return { messages, taskCounter }
  }

  const listMessage: ChatMessage = {
    id: listId,
    type: 'task-list',
    content: '',
    tasks,
    timestamp: existingList?.timestamp ?? now
  }

  if (existingIndex >= 0) {
    const next = [...messages]
    next[existingIndex] = listMessage
    return { messages: next, taskCounter: nextCounter }
  }
  return { messages: [...messages, listMessage], taskCounter: nextCounter }
}
