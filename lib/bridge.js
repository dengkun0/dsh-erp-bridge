import { mkdir } from 'node:fs/promises'
import { JsonlLedger, ledgerPaths } from './ledger.js'
import { normalizeConfig } from './config.js'
import { SecretStore } from './secrets.js'
import { createAdapter } from './adapters/index.js'
import { SessionTracker } from './sessions.js'
import { Ingress } from './ingress.js'
import { InboxPump } from './inbox.js'
import { Outbox } from './outbox.js'
import { registerTools } from './tools.js'
import { errorMessage, redact } from './util.js'

/**
 * Owns one bridge process: adapter, two ledgers, inbound listener, outbox
 * delivery, tools, and the session-log projection. Construction validates
 * configuration and throws; asynchronous I/O starts in start().
 */
export class ErpBridge {
  constructor(ctx, rawConfig) {
    this.ctx = ctx
    const { config, warnings } = normalizeConfig(rawConfig)
    this.config = config
    this.warnings = warnings
    this.started = false
    this.stopped = false
    this.toolDisposers = []
    this.listeners = []
    this.ready = Promise.resolve()
    this.ingressError = undefined

    const paths = ledgerPaths(config.dataDir)
    this.inboxLedger = new JsonlLedger(paths.inbox, 'inbox', {
      maxBytes: config.ledger.maxBytes,
      keepDone: config.ledger.keepDone,
    })
    this.outboxLedger = new JsonlLedger(paths.outbox, 'outbox', {
      maxBytes: config.ledger.maxBytes,
      keepDone: config.ledger.keepDone,
    })
    this.secrets = new SecretStore(ctx, config.dataDir)
    this.adapter = createAdapter(config.adapter, { secrets: this.secrets })
    this.tracker = new SessionTracker(ctx)
    this.inbox = new InboxPump({ ctx, config, ledger: this.inboxLedger, tracker: this.tracker })
    this.outbox = new Outbox({
      ctx,
      config,
      ledger: this.outboxLedger,
      adapter: this.adapter,
      secrets: this.secrets,
      tracker: this.tracker,
    })
    this.ingress = new Ingress({
      ctx,
      config,
      secrets: this.secrets,
      inbox: this.inboxLedger,
      onAccepted: () => this.inbox.kick(),
      onIgnored: () => {},
    })
  }

  /** Register listeners and begin asynchronous initialization. Returns the disposer. */
  start() {
    if (this.started) return () => this.stop()
    this.started = true
    this.tracker.start()
    this.listeners.push(this.ctx.on('session/event', (session, event) => {
      this.outbox.onSessionEvent(session, event)
    }))
    this.ready = this.initialize().catch((error) => {
      this.ingressError = errorMessage(error)
      this.ctx.logger?.error?.(`[erp-bridge] initialization failed: ${this.ingressError}`)
    })
    return () => this.stop()
  }

  async initialize() {
    await mkdir(this.config.dataDir, { recursive: true, mode: 0o700 })
    try {
      await mkdir(this.config.inbound.workspacePath, { recursive: true, mode: 0o700 })
    } catch (error) {
      this.ctx.logger?.warn?.(`[erp-bridge] could not create inbound workspace ${this.config.inbound.workspacePath}: ${errorMessage(error)}`)
    }
    const [inboxInfo, outboxInfo] = await Promise.all([this.inboxLedger.open(), this.outboxLedger.open()])
    if (inboxInfo.corrupt || outboxInfo.corrupt) {
      this.ctx.logger?.warn?.(`[erp-bridge] ignored ${inboxInfo.corrupt + outboxInfo.corrupt} corrupt ledger line(s)`)
    }
    for (const warning of this.warnings) this.ctx.logger?.warn?.(`[erp-bridge] config: ${warning}`)

    this.toolDisposers = registerTools({
      ctx: this.ctx,
      config: this.config,
      adapter: this.adapter,
      inbox: this.inbox,
      outbox: this.outbox,
      tracker: this.tracker,
      secrets: this.secrets,
      ingress: this.ingress,
    })

    try {
      await this.ingress.start()
    } catch (error) {
      this.ingressError = errorMessage(error)
      this.ctx.logger?.error?.(`[erp-bridge] ingress is unavailable: ${this.ingressError}`)
    }
    this.inbox.start()
    this.outbox.start()
    this.ctx.logger?.info?.(`[erp-bridge] ready adapter=${this.adapter.id} dataDir=${this.config.dataDir} ingress=${this.ingress.mode} tools=${this.toolDisposers.length}`)
    if (this.config.debug) {
      this.ctx.logger?.debug?.(`[erp-bridge] resolved config: ${JSON.stringify(redact(this.config))}`)
    }
  }

  async stop() {
    if (this.stopped) return
    this.stopped = true
    for (const dispose of this.listeners.splice(0)) {
      try { dispose() } catch { /* already gone */ }
    }
    for (const dispose of this.toolDisposers.splice(0)) {
      try { dispose() } catch { /* already gone */ }
    }
    this.tracker.stop()
    await Promise.allSettled([
      this.inbox.stop(),
      this.outbox.stop(),
      this.ingress.stop(),
      this.ready,
    ])
  }

  status() {
    return {
      adapter: this.adapter.id,
      ingress: this.ingress.status(),
      inbound: this.inbox.status(),
      outbound: this.outbox.status(),
      ingressError: this.ingressError,
    }
  }
}
