/**
 * ClientToolHandler — host-injected execution layer for ACP-style providers.
 *
 * In Pattern A providers (Claude SDK, Codex SDK), the agent's runtime
 * executes tools (fs, shell) itself; the host gates via `canUseTool`. In
 * Pattern B (ACP — Gemini today, others tomorrow), the agent makes JSON-RPC
 * requests *back* to the client (Jack) for fs / terminal / tools — the
 * client IS the runtime.
 *
 * `ClientToolHandler` is the contract the host implements and the provider
 * package consumes. The provider receives a handler via
 * `JackProvider.attachClientToolHandler(handler)` once per spawn and
 * delegates every fs/terminal/tools request to it instead of calling
 * `node:fs` directly. The host returns environment-aware handlers:
 *
 *   - `nodeClientToolHandler` — default. Local `node:fs` + `node-pty`.
 *   - `dockerClientToolHandler` — sandboxed sessions. Routes ops via
 *     `docker exec` so the agent's view (paths, env) lines up with the
 *     container's filesystem rather than the host's.
 *   - (future) `remoteClientToolHandler` — team-tier "agent on shared
 *     server" scenarios.
 *
 * The provider doesn't see the difference — same interface, different
 * implementation behind it.
 *
 * Full design: `docs/acp-integration-design.md`.
 */

/**
 * Per-request context the host attaches so the handler can correlate
 * activity with a Jack session (audit log, transversal slot guard, etc).
 */
export type ClientToolHandlerContext = {
  /** Jack-side session id (matches `sessions.id`). */
  sessionId: string
  /**
   * Provider-side conversation id (e.g. ACP `sessionId` from
   * `session/new`). Optional — populated only after the agent has
   * negotiated one. Useful for cross-referencing rollouts.
   */
  providerSessionId?: string
  /** The cwd the agent session was spawned with. */
  cwd: string
}

/** Top-level handler grouping. */
export type ClientToolHandler = {
  fs: ClientFsHandler
  terminal: ClientTerminalHandler
  tools: ClientToolsHandler
}

// ─── Filesystem ──────────────────────────────────────────────────────────

export type ClientFsHandler = {
  /**
   * Read a file as UTF-8. Path is whatever the agent sent — handler
   * decides whether to resolve locally or in a sandboxed root, and
   * refuses paths outside the allowed roots. Throws on permission denial
   * or missing file.
   */
  readTextFile(path: string, ctx: ClientToolHandlerContext): Promise<string>

  /**
   * Write a file. Creates parent directories if needed. Throws on
   * permission denial or path-outside-allowed-roots.
   */
  writeTextFile(
    path: string,
    content: string,
    ctx: ClientToolHandlerContext
  ): Promise<void>
}

// ─── Terminal ────────────────────────────────────────────────────────────

export type TerminalSpec = {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  /** Bytes after which output is truncated. Handler best-effort. */
  outputByteLimit?: number
}

export type TerminalHandle = {
  /**
   * Opaque id the handler uses internally. The provider stores it and
   * passes it back on subsequent terminal/* calls.
   */
  terminalId: string
}

export type TerminalOutput = {
  /** Concatenated stdout + stderr captured so far. */
  output: string
  /** True when the buffer was truncated to `outputByteLimit`. */
  truncated: boolean
  /** Set when the process has exited; undefined while still running. */
  exitStatus?: { exitCode: number }
}

export type ClientTerminalHandler = {
  create(
    spec: TerminalSpec,
    ctx: ClientToolHandlerContext
  ): Promise<TerminalHandle>

  /** Snapshot the current output buffer. Non-blocking. */
  output(handle: TerminalHandle): Promise<TerminalOutput>

  /** Block until the process exits. */
  waitForExit(handle: TerminalHandle): Promise<{ exitCode: number }>

  /** Send SIGTERM (then SIGKILL if needed). */
  kill(handle: TerminalHandle): Promise<void>

  /** Free handler-internal resources. Idempotent. */
  release(handle: TerminalHandle): Promise<void>
}

// ─── Tools ───────────────────────────────────────────────────────────────

/**
 * A tool the host registered for the session — equivalent of Pattern A's
 * `attachInProcessMcpServer` spec, but exposed via ACP `tools/list` /
 * `tools/call`.
 */
export type RegisteredTool = {
  name: string
  description: string
  /** JSON Schema for the tool's input. */
  inputSchema: Record<string, unknown>
}

export type ToolCallResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

export type ClientToolsHandler = {
  /**
   * Tools the host has registered for this session. Provider returns
   * these to the agent on `tools/list`. Empty array when no host tools
   * are registered (e.g. solo session, no pair-mode).
   */
  list(ctx: ClientToolHandlerContext): Promise<RegisteredTool[]>

  /** Dispatch an agent's `tools/call` to the registered handler. */
  call(
    name: string,
    args: unknown,
    ctx: ClientToolHandlerContext
  ): Promise<ToolCallResult>
}
