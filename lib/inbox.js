import { randomUUID } from 'node:crypto'
import { backoffDelay, errorMessage, oneLine, truncate } from './util.js'
import { renderPrompt } from './config.js'
import { eventsHaveMarker } from './sessions.js'

function permanentError(message) {
  const error = new Error(message)
  error.permanent = true
  return error
}

function isNotFound(error) {
  const message = errorMessage(error)
  return /not[ -]?found|no such session|unknown session/i.test(message) || error?.code === 'session/not-found'
}

/**
 * Inbound queue pump. The HTTP handler only writes the ledger and answers
 * 202; this pump creates the read-only Session, verifies the permission
 * preset, checks the prompt marker, and admits exactly one prompt. Every step
 * is retried from the durable ledger, so a crash cannot lose an event.
 */
export class InboxPump {
  constructor({ ctx, config, ledger, tracker }) {
    this.ctx = ctx
    this.config = config
    this.ledger = ledger
    this.tracker = tracker
    this.timer = undefined
    this.running = false
    this.pending = false
    this.stopped = false
    this.active = new Set()
    this.current = Promise.resolve()
    this.lastError = undefined
    this.lastRunAt = undefined
  }

  start() {
    this.timer = setInterval(() => this.kick(), this.config.inbound.pollIntervalMs)
    this.timer.unref?.()
    this.kick()
  }

  async stop() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.current.catch(() => {})
  }

  kick() {
    if (this.stopped || !this.config.inbound.enabled) return
    if (this.running) {
      this.pending = true
      return
    }
    this.current = this.tick().catch((error) => {
      this.lastError = errorMessage(error)
      this.ctx.logger?.error?.(`[erp-bridge] inbox pump failed: ${this.lastError}`)
    })
  }

  async tick() {
    if (this.running) {
      this.pending = true
      return
    }
    this.running = true
    try {
      do {
        this.pending = false
        this.lastRunAt = Date.now()
        const now = Date.now()
        const due = this.ledger.list()
          .filter((entry) => (entry.state === 'received' || entry.state === 'session-created')
            && entry.nextAt <= now
            && !this.active.has(entry.id))
          .sort((left, right) => left.receivedAt - right.receivedAt)
          .slice(0, 4)
        if (due.length === 0) break
        await Promise.all(due.map((entry) => this.process(entry)))
      } while (this.pending)
    } finally {
      this.running = false
    }
  }

  async process(entry) {
    if (this.active.has(entry.id)) return
    this.active.add(entry.id)
    const attempts = (entry.attempts ?? 0) + 1
    try {
      const sessionId = entry.sessionId ?? randomUUID()
      if (!entry.sessionId) await this.ledger.append({ t: 'sid', id: entry.id, sessionId })

      const sessionController = this.ctx.get?.('sessionController')
      if (!sessionController?.create || !sessionController?.prompt) {
        throw permanentError('sessionController service is unavailable; inbound sessions cannot be opened')
      }
      if (!this.ctx.get?.('permissionPresets')) {
        throw permanentError('permissionPresets service is unavailable; refusing to open a session without a read-only preset')
      }

      const cwd = this.config.inbound.workspacePath
        || this.ctx.get?.('workingDirectory')?.defaultDirectory
        || process.cwd()
      let session = this.tracker.get(sessionId)
      let events = []
      let exists = false
      if (entry.attempts > 0 || entry.sessionId) {
        try {
          const inspection = await sessionController.inspect(sessionId)
          events = inspection?.events ?? []
          exists = true
        } catch (error) {
          if (!isNotFound(error)) throw error
        }
      }
      if (!exists) {
        await sessionController.create({ sessionId, cwd, agentPreset: this.config.inbound.agentPreset })
        session = await this.tracker.waitForSession(sessionId, 3000)
        if (!session) {
          const agent = this.ctx.get?.('agents')?.get(sessionId)
          session = agent?.session
        }
        if (!session) throw permanentError(`session ${sessionId} was created but never published`)
        events = session.snapshotEvents()
      } else if (!session) {
        session = await this.tracker.waitForSession(sessionId, 500)
        if (!session) throw permanentError(`session ${sessionId} is persisted but not live; cannot apply the read-only preset`)
        events = session.snapshotEvents()
      }

      const applied = this.tracker.applyReadOnly(sessionId, this.config.inbound.permissionPreset)
      if (!applied.ok) {
        throw permanentError(`read-only preset "${this.config.inbound.permissionPreset}" could not be applied: ${applied.reason}`)
      }

      const marker = `[erp-bridge:${entry.id}]`
      if (eventsHaveMarker(events, marker)) {
        await this.finish(entry, sessionId)
        return
      }

      const envelope = entry.payload
      const eventJson = truncate(JSON.stringify(envelope, null, 2), this.config.inbound.maxEventChars)
      const prompt = renderPrompt(this.config.inbound.promptTemplate, {
        deliveryId: entry.id,
        source: entry.source || envelope.source || this.config.adapter.id,
        eventName: entry.eventName || envelope.eventName,
        entityType: envelope.entity?.type || 'unknown',
        entityId: envelope.entity?.id || 'unknown',
        occurredAt: new Date(envelope.occurredAt ?? Date.now()).toISOString(),
        eventJson: `${eventJson}\n\n${marker}`,
      })

      await sessionController.prompt({
        sessionId,
        requestId: `erp-${entry.id}`,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
        ...(this.config.inbound.clientTimeZone ? { clientTimeZone: this.config.inbound.clientTimeZone } : {}),
      }, AbortSignal.timeout(20000))
      await this.finish(entry, sessionId)
    } catch (error) {
      const message = oneLine(errorMessage(error), 800)
      const permanent = error.permanent === true || attempts >= this.config.inbound.maxAttempts
      if (permanent) {
        this.lastError = message
        await this.ledger.append({ t: 'failed', id: entry.id, error: message })
        this.ctx.logger?.error?.(`[erp-bridge] inbox ${entry.id} failed permanently: ${message}`)
      } else {
        const nextAt = Date.now() + backoffDelay(attempts, this.config.inbound.retryBaseMs, this.config.inbound.retryMaxMs)
        await this.ledger.append({ t: 'attempt', id: entry.id, attempts, nextAt, error: message })
        this.ctx.logger?.warn?.(`[erp-bridge] inbox ${entry.id} attempt ${attempts} failed; retrying at ${new Date(nextAt).toISOString()}: ${message}`)
      }
    } finally {
      this.active.delete(entry.id)
    }
  }

  async finish(entry, sessionId) {
    this.tracker.linkInbound(sessionId, {
      deliveryId: entry.id,
      source: entry.source,
      eventName: entry.eventName,
      entity: entry.payload?.entity,
    })
    await this.ledger.append({ t: 'prompted', id: entry.id, sessionId })
  }

  /** Retry one failed delivery from the durable ledger. */
  async retry(id) {
    const entry = this.ledger.get(id)
    if (!entry) throw new Error(`unknown inbox delivery "${id}"`)
    if (entry.state !== 'failed') throw new Error(`inbox delivery "${id}" is ${entry.state}, not failed`)
    await this.ledger.append({ t: 'retry', id })
    this.kick()
    return { id, state: 'received' }
  }

  status() {
    const stats = this.ledger.stats()
    return {
      enabled: this.config.inbound.enabled,
      running: this.running,
      active: this.active.size,
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
      entries: stats.entries,
      states: stats.counts,
      nextAt: Math.min(...this.ledger.list().filter((entry) => entry.state === 'received' || entry.state === 'session-created').map((entry) => entry.nextAt ?? 0), Infinity) || null,
    }
  }
}
