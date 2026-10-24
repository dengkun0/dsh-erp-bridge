import {
  backoffDelay,
  errorMessage,
  hmacHex,
  oneLine,
  readTextCapped,
  toJsonValue,
  truncate,
} from './util.js'
import { eventsForTurn, extractSummary, extractToolCalls, usedErpTools } from './sessions.js'

/**
 * Outbound projection and delivery. One durable `put` is written before the
 * first HTTP attempt; retries and terminal states are appended as facts. A
 * `turn/end` from a session that neither originated in ERP nor used an ERP
 * tool is ignored in the default `linked` scope.
 */
export class Outbox {
  constructor({ ctx, config, ledger, adapter, secrets, tracker }) {
    this.ctx = ctx
    this.config = config
    this.ledger = ledger
    this.adapter = adapter
    this.secrets = secrets
    this.tracker = tracker
    this.timer = undefined
    this.running = false
    this.pending = false
    this.stopped = false
    this.active = new Set()
    this.current = Promise.resolve()
    this.lastError = undefined
    this.lastDeliveredAt = undefined
    this.delivered = 0
    this.failed = 0
  }

  start() {
    this.timer = setInterval(() => this.kick(), this.config.outbound.pollIntervalMs)
    this.timer.unref?.()
    this.kick()
  }

  async stop() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.current.catch(() => {})
  }

  /** Called for every committed session event; only turn/end matters here. */
  onSessionEvent(session, event) {
    if (!this.config.outbound.enabled || event?.type !== 'turn/end') return
    void this.enqueue(session, event).catch((error) => {
      this.lastError = errorMessage(error)
      this.ctx.logger?.error?.(`[erp-bridge] outbox projection failed: ${this.lastError}`)
    })
  }

  async enqueue(session, event) {
    const turn = event.data?.turn
    if (!Number.isInteger(turn)) return
    if (!this.ledger.ready) {
      this.ctx.logger?.debug?.(`[erp-bridge] turn ${session.id}:${turn} ended before the ledger was ready; not queued`)
      return
    }
    const id = `${session.id}:${turn}`
    if (this.ledger.get(id)) return
    const events = eventsForTurn(session, turn)
    const inbound = this.tracker.inboundFor(session.id)
    const usedErp = usedErpTools(events)
    const allowed = this.config.outbound.scope === 'all'
      || (this.config.outbound.scope === 'linked' && Boolean(inbound))
      || (this.config.outbound.scope === 'erp-tools' && (Boolean(inbound) || usedErp))
    if (!allowed) return
    const payload = this.buildPayload(session, turn, events, event, inbound)
    let write
    try {
      write = await this.adapter.buildResultWrite?.(payload)
    } catch (error) {
      this.ctx.logger?.warn?.(`[erp-bridge] adapter could not build a result write: ${errorMessage(error)}`)
      return
    }
    const target = write?.url || this.config.outbound.targetUrl
    if (!target) {
      this.ctx.logger?.debug?.(`[erp-bridge] turn ${id} is linked but outbound.targetUrl is empty; not queued`)
      return
    }
    await this.ledger.append({
      t: 'put',
      id,
      idempotencyKey: id,
      payload: write?.body ?? payload,
      target,
      headers: write?.headers,
    })
    this.kick()
  }

  buildPayload(session, turn, events, endEvent, inbound) {
    const rawSummary = this.config.outbound.includeSummary ? extractSummary(events) : ''
    const summary = truncate(rawSummary, this.config.outbound.summaryMaxChars)
    const payload = {
      version: 1,
      event: 'turn.end',
      sessionId: session.id,
      turn,
      status: endEvent.data?.reason?.kind ?? 'completed',
      reason: toJsonValue(endEvent.data?.reason ?? { kind: 'completed' }),
      startedAt: events[0]?.time ?? null,
      endedAt: endEvent.time ?? Date.now(),
      summary,
      summaryTruncated: rawSummary.length > summary.length,
      toolCalls: extractToolCalls(events, { includeArguments: this.config.outbound.includeToolArguments }),
      adapter: this.adapter.id,
      ...(inbound ? {
        erp: {
          deliveryId: inbound.deliveryId,
          source: inbound.source,
          eventName: inbound.eventName,
          entity: toJsonValue(inbound.entity),
        },
      } : {}),
    }
    return toJsonValue(payload)
  }

  kick() {
    if (this.stopped || !this.config.outbound.enabled) return
    if (this.running) {
      this.pending = true
      return
    }
    this.current = this.tick().catch((error) => {
      this.lastError = errorMessage(error)
      this.ctx.logger?.error?.(`[erp-bridge] outbox pump failed: ${this.lastError}`)
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
        const now = Date.now()
        const due = this.ledger.list()
          .filter((entry) => entry.state === 'pending' && entry.nextAt <= now && !this.active.has(entry.id))
          .sort((left, right) => left.createdAt - right.createdAt)
          .slice(0, 4)
        if (due.length === 0) break
        await Promise.all(due.map((entry) => this.deliver(entry)))
      } while (this.pending)
    } finally {
      this.running = false
    }
  }

  async deliver(entry) {
    if (this.active.has(entry.id)) return
    this.active.add(entry.id)
    const attempts = (entry.attempts ?? 0) + 1
    try {
      const secret = await this.secrets.resolve(this.config.outbound.signature.secretRef, {
        autoGenerate: this.config.outbound.signature.autoGenerate,
      })
      const body = typeof entry.payload === 'string' ? entry.payload : JSON.stringify(entry.payload)
      const timestamp = String(Math.floor(Date.now() / 1000))
      const signature = hmacHex(secret.value, `${timestamp}.${body}`)
      const headers = {
        'content-type': 'application/json',
        'user-agent': 'dsh-erp-bridge/0.1.0',
        'idempotency-key': entry.idempotencyKey,
        'x-dsh-delivery-id': entry.id,
        'x-dsh-timestamp': timestamp,
        'x-dsh-signature': `sha256=${signature}`,
        ...(entry.headers ?? {}),
      }
      let response
      try {
        response = await fetch(entry.target, {
          method: 'POST',
          headers,
          body,
          redirect: 'error',
          signal: AbortSignal.timeout(this.config.outbound.timeoutMs),
        })
      } catch (error) {
        await this.retryOrFail(entry, attempts, undefined, errorMessage(error))
        return
      }
      const responseText = truncate(await readTextCapped(response, 4096), 4000)
      if (response.ok) {
        await this.ledger.append({ t: 'done', id: entry.id, status: response.status })
        this.delivered += 1
        this.lastDeliveredAt = Date.now()
        return
      }
      const retryable = response.status === 408
        || response.status === 425
        || response.status === 429
        || response.status >= 500
      if (!retryable) {
        await this.ledger.append({
          t: 'failed',
          id: entry.id,
          error: `HTTP ${response.status}: ${oneLine(responseText, 300)}`,
          status: response.status,
        })
        this.failed += 1
        return
      }
      const retryAfter = Number(response.headers.get('retry-after'))
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(this.config.outbound.maxDelayMs, Math.max(1000, retryAfter * 1000))
        : undefined
      await this.retryOrFail(entry, attempts, response.status, `HTTP ${response.status}: ${oneLine(responseText, 300)}`, delay)
    } catch (error) {
      await this.retryOrFail(entry, attempts, undefined, errorMessage(error))
    } finally {
      this.active.delete(entry.id)
    }
  }

  async retryOrFail(entry, attempts, status, error, explicitDelay) {
    if (attempts >= this.config.outbound.maxAttempts) {
      await this.ledger.append({ t: 'failed', id: entry.id, error: oneLine(error, 800), status })
      this.failed += 1
      this.lastError = oneLine(error, 800)
      return
    }
    const delay = explicitDelay ?? backoffDelay(attempts, this.config.outbound.baseDelayMs, this.config.outbound.maxDelayMs)
    await this.ledger.append({
      t: 'attempt',
      id: entry.id,
      attempts,
      status,
      nextAt: Date.now() + delay,
      error: oneLine(error, 800),
    })
    this.lastError = oneLine(error, 800)
  }

  /** Retry one permanently failed outbox entry. */
  async resend(id) {
    const entry = this.ledger.get(id)
    if (!entry) throw new Error(`unknown outbox delivery "${id}"`)
    if (entry.state !== 'failed') throw new Error(`outbox delivery "${id}" is ${entry.state}, not failed`)
    await this.ledger.append({ t: 'retry', id })
    this.kick()
    return { id, state: 'pending' }
  }

  status() {
    const stats = this.ledger.stats()
    const pending = this.ledger.list().filter((entry) => entry.state === 'pending')
    const done = this.ledger.list().filter((entry) => entry.state === 'done').length
    const failed = this.ledger.list().filter((entry) => entry.state === 'failed').length
    return {
      enabled: this.config.outbound.enabled,
      target: this.config.outbound.targetUrl || null,
      scope: this.config.outbound.scope,
      running: this.running,
      active: this.active.size,
      delivered: done,
      failed,
      deliveredSinceStart: this.delivered,
      failedSinceStart: this.failed,
      lastDeliveredAt: this.lastDeliveredAt,
      lastError: this.lastError,
      entries: stats.entries,
      states: stats.counts,
      pending: pending.length,
      nextAt: Math.min(...pending.map((entry) => entry.nextAt ?? 0), Infinity) || null,
    }
  }
}
