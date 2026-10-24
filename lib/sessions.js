import { errorMessage, toJsonValue, truncate } from './util.js'

/** Extract plain text from one message content value. */
export function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** Return the committed events that belong to one turn, in log order. */
export function eventsForTurn(session, turn) {
  const events = session.snapshotEvents()
  let start = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === 'turn/start' && events[index].data?.turn === turn) {
      start = index
      break
    }
  }
  if (start === -1) return events.filter((event) => event.data?.turn === turn)
  let end = events.length
  for (let index = start + 1; index < events.length; index += 1) {
    if (events[index].type === 'turn/end' && events[index].data?.turn === turn) {
      end = index + 1
      break
    }
  }
  return events.slice(start, end)
}

/** Last non-empty assistant text in the supplied events. */
export function extractSummary(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type !== 'assistant/message') continue
    const text = contentText(event.data?.message?.content).trim()
    if (text) return text
  }
  return ''
}

/** Tool calls paired with their results from the supplied events. */
export function extractToolCalls(events, { includeArguments = false } = {}) {
  const calls = new Map()
  for (const event of events) {
    if (event.type === 'tool/call') {
      calls.set(event.data.callId, {
        callId: event.data.callId,
        name: event.data.name,
        ok: undefined,
        ...(includeArguments ? { arguments: truncate(event.data.arguments ?? '', 1000) } : {}),
      })
    } else if (event.type === 'tool/result') {
      const callId = event.data.message?.toolCallId
      const call = calls.get(callId)
      if (!call) continue
      const message = event.data.message
      const failed = event.data.error !== undefined || message?.isError === true
      call.ok = !failed
      if (event.data.error) call.error = event.data.error.code ?? event.data.error.name
      else if (message?.isError) call.error = truncate(contentText(message.content), 200) || 'tool-error'
    }
  }
  return [...calls.values()]
}

/** Approval audit fragments as they appear in the committed log. */
export function extractApprovals(events) {
  return events
    .filter((event) => typeof event.type === 'string' && event.type.startsWith('approval/'))
    .map((event) => ({ type: event.type, seq: event.seq, time: event.time, data: toJsonValue(event.data) }))
}

/** True when a session used one of this bridge's tools. */
export function usedErpTools(events) {
  return events.some((event) => event.type === 'tool/call' && typeof event.data?.name === 'string' && event.data.name.startsWith('erp_'))
}

/** True when an inbound prompt marker is already in the session log. */
export function hasPromptMarker(session, marker) {
  if (!marker) return false
  return eventsHaveMarker(session.snapshotEvents(), marker)
}

/** True when any committed user message text contains the marker. */
export function eventsHaveMarker(events, marker) {
  if (!marker) return false
  for (const event of events) {
    if (event.type !== 'user/message') continue
    if (contentText(event.data?.content).includes(marker)) return true
  }
  return false
}

/**
 * Track live Sessions, inbound links, and the read-only transition. The
 * Session log remains the source of truth; this map is a derived cache used by
 * the outbox projection and the audit tool.
 */
export class SessionTracker {
  constructor(ctx) {
    this.ctx = ctx
    this.sessions = new Map()
    this.inbound = new Map()
    this.disposers = []
  }

  start() {
    this.disposers.push(this.ctx.on('session/created', (session) => {
      this.sessions.set(session.id, session)
    }))
    this.disposers.push(this.ctx.on('session/event', (session) => {
      this.sessions.set(session.id, session)
    }))
    this.disposers.push(this.ctx.on('session/disposed', (session) => {
      this.sessions.delete(session.id)
    }))
    const sessions = this.ctx.get?.('sessions')
    if (sessions?.list) {
      for (const session of sessions.list()) this.sessions.set(session.id, session)
    }
  }

  stop() {
    for (const dispose of this.disposers.splice(0)) {
      try { dispose() } catch { /* already gone */ }
    }
    this.sessions.clear()
    this.inbound.clear()
  }

  get(sessionId) {
    return this.sessions.get(sessionId)
  }

  /** Record that one inbound delivery opened this Session. */
  linkInbound(sessionId, info) {
    this.inbound.set(sessionId, info)
  }

  inboundFor(sessionId) {
    return this.inbound.get(sessionId)
  }

  /** Wait briefly for the publication of one exact Session. */
  waitForSession(sessionId, timeoutMs = 3000) {
    const existing = this.sessions.get(sessionId)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve) => {
      let dispose
      const timer = setTimeout(() => {
        dispose?.()
        resolve(undefined)
      }, timeoutMs)
      dispose = this.ctx.on('session/created', (session) => {
        if (session.id !== sessionId) return
        clearTimeout(timer)
        dispose?.()
        resolve(session)
      })
    })
  }

  /**
   * Switch one already-published Session to the configured read-only preset
   * and verify the projection agrees. Returns a failure instead of throwing so
   * an inbound pump can fail closed with a precise reason.
   */
  applyReadOnly(sessionId, preset) {
    const permissionPresets = this.ctx.get?.('permissionPresets')
    if (!permissionPresets) return { ok: false, reason: 'permissionPresets service is unavailable' }
    const session = this.sessions.get(sessionId) ?? this.ctx.get?.('agents')?.get(sessionId)?.session
    if (!session) return { ok: false, reason: 'session is not published yet' }
    try {
      permissionPresets.set(session, preset)
      const current = permissionPresets.current(session)
      return current === preset
        ? { ok: true, preset: current }
        : { ok: false, reason: `permission preset is "${current}" after switching to "${preset}"` }
    } catch (error) {
      return { ok: false, reason: errorMessage(error) }
    }
  }
}
