import { createServer } from 'node:http'
import {
  HttpError,
  errorMessage,
  hmacHex,
  normalizeSignature,
  parseUnixTimestamp,
  readBody,
  safeEqualHex,
  sendJson,
  sha256Hex,
  stableJson,
} from './util.js'
import { validateEnvelope } from './config.js'

/**
 * The inbound HTTP surface. Standalone mode owns a separate loopback listener
 * (the production default); embedded mode registers two exact routes on the
 * existing DSH web server for demos. Either way the only accepted operation is
 * a signed POST on one configured path.
 */
export class Ingress {
  /**
   * @param {{
   *   ctx: import('@deepseek-ai/cordis').Context,
   *   config: object,
   *   secrets: import('./secrets.js').SecretStore,
   *   inbox: import('./ledger.js').JsonlLedger,
   *   onAccepted: (deliveryId: string) => void,
   *   onIgnored: (deliveryId: string) => void,
   * }} deps
   */
  constructor(deps) {
    this.ctx = deps.ctx
    this.config = deps.config
    this.secrets = deps.secrets
    this.inbox = deps.inbox
    this.onAccepted = deps.onAccepted
    this.onIgnored = deps.onIgnored
    this.server = undefined
    this.disposers = []
    this.mode = 'off'
    this.port = undefined
    this.lastError = undefined
    this.accepted = 0
    this.duplicates = 0
    this.rejected = 0
    this.ignored = 0
  }

  get url() {
    if (this.mode === 'standalone' && this.port) return `http://${this.config.ingress.host}:${this.port}${this.config.ingress.path}`
    if (this.mode === 'embedded') {
      try {
        return `${this.ctx.webServer.getOrigin()}${this.config.ingress.path}`
      } catch {
        return this.config.ingress.path
      }
    }
    return undefined
  }

  async start() {
    if (!this.config.ingress.enabled) {
      this.mode = 'disabled'
      return this.status()
    }
    if (this.config.ingress.mode === 'embedded') {
      const webServer = this.ctx.get?.('webServer')
      if (!webServer) throw new Error('ingress.mode is embedded but no webServer service is composed')
      this.disposers.push(webServer.register({
        kind: 'exact',
        path: this.config.ingress.path,
        handler: (req, res) => this.handle(req, res),
      }))
      this.disposers.push(webServer.register({
        kind: 'exact',
        path: this.config.ingress.healthPath,
        handler: (req, res) => this.handleHealth(req, res),
      }))
      this.mode = 'embedded'
      this.ctx.logger?.info?.(`[erp-bridge] ingress embedded at ${this.config.ingress.path}`)
      return this.status()
    }

    this.server = createServer((req, res) => {
      void this.handle(req, res)
    })
    this.server.headersTimeout = 15000
    this.server.requestTimeout = 30000
    this.server.keepAliveTimeout = 5000
    this.server.on('clientError', (error, socket) => {
      this.ctx.logger?.debug?.(`[erp-bridge] ingress client error: ${errorMessage(error)}`)
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    })
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server?.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        this.server?.off('error', onError)
        resolve()
      }
      this.server.once('error', onError)
      this.server.once('listening', onListening)
      this.server.listen(this.config.ingress.port, this.config.ingress.host)
    }).catch((error) => {
      this.lastError = errorMessage(error)
      try { this.server?.close() } catch { /* never listened */ }
      throw new Error(`ingress failed to listen on ${this.config.ingress.host}:${this.config.ingress.port}: ${this.lastError}`)
    })
    const address = this.server.address()
    this.port = typeof address === 'object' && address ? address.port : this.config.ingress.port
    this.mode = 'standalone'
    this.ctx.logger?.info?.(`[erp-bridge] ingress listening on ${this.url}`)
    return this.status()
  }

  async stop() {
    for (const dispose of this.disposers.splice(0)) {
      try { dispose() } catch { /* already gone */ }
    }
    if (this.server) {
      const server = this.server
      this.server = undefined
      await new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    }
    this.mode = 'off'
  }

  status() {
    return {
      mode: this.mode,
      url: this.url,
      port: this.port,
      accepted: this.accepted,
      duplicates: this.duplicates,
      rejected: this.rejected,
      ignored: this.ignored,
      lastError: this.lastError,
    }
  }

  handleHealth(req, res) {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, code: 'method-not-allowed' }, { allow: 'GET' })
      return
    }
    const inbox = this.inbox.stats()
    sendJson(res, 200, {
      ok: true,
      service: 'dsh-erp-bridge',
      adapter: this.config.adapter.id,
      ingress: { mode: this.mode, path: this.config.ingress.path },
      inbox: { entries: inbox.entries, states: inbox.counts, corrupt: inbox.corrupt },
      time: new Date().toISOString(),
    })
  }

  async handle(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname === this.config.ingress.healthPath) {
        this.handleHealth(req, res)
        return
      }
      if (url.pathname !== this.config.ingress.path) {
        sendJson(res, 404, { ok: false, code: 'not-found' })
        return
      }
      if (req.method !== 'POST') {
        this.rejected += 1
        sendJson(res, 405, { ok: false, code: 'method-not-allowed' }, { allow: 'POST' })
        return
      }
      if (!this.inbox.ready) {
        sendJson(res, 503, { ok: false, code: 'not-ready' }, { 'retry-after': '2' })
        return
      }

      const signatureConfig = this.config.ingress.signature
      const timestampRaw = String(firstHeader(req.headers[signatureConfig.headerTimestamp]) ?? '')
      const timestamp = parseUnixTimestamp(timestampRaw)
      const given = normalizeSignature(firstHeader(req.headers[signatureConfig.headerSignature]))
      if (!timestamp || !given) {
        this.rejected += 1
        sendJson(res, 401, { ok: false, code: 'unauthorized' })
        return
      }
      const nowSec = Math.floor(Date.now() / 1000)
      if (Math.abs(nowSec - timestamp) > signatureConfig.timestampWindowSec) {
        this.rejected += 1
        sendJson(res, 401, { ok: false, code: 'stale-timestamp' })
        return
      }

      let secret
      try {
        secret = await this.secrets.resolve(signatureConfig.secretRef, { autoGenerate: signatureConfig.autoGenerate })
      } catch (error) {
        this.ctx.logger?.error?.(`[erp-bridge] ingress has no secret: ${errorMessage(error)}`)
        sendJson(res, 503, { ok: false, code: 'secret-unavailable' }, { 'retry-after': '5' })
        return
      }

      const raw = await readBody(req, this.config.ingress.maxBodyBytes)
      const expected = hmacHex(secret.value, `${timestampRaw}.${raw.toString('utf8')}`)
      if (!safeEqualHex(expected, given)) {
        this.rejected += 1
        this.ctx.logger?.warn?.('[erp-bridge] ingress rejected a request with an invalid HMAC signature')
        sendJson(res, 401, { ok: false, code: 'unauthorized' })
        return
      }

      let parsed
      try {
        parsed = JSON.parse(raw.toString('utf8'))
      } catch {
        this.rejected += 1
        sendJson(res, 400, { ok: false, code: 'bad-json' })
        return
      }
      let envelope
      try {
        envelope = validateEnvelope(parsed)
      } catch (error) {
        this.rejected += 1
        sendJson(res, 400, { ok: false, code: 'invalid-envelope', message: errorMessage(error) })
        return
      }
      envelope.source = envelope.source || this.config.adapter.id
      const bodyHash = sha256Hex(stableJson(parsed))
      const existing = this.inbox.get(envelope.deliveryId)
      if (existing) {
        if (existing.bodyHash && existing.bodyHash !== bodyHash) {
          this.rejected += 1
          sendJson(res, 409, { ok: false, code: 'delivery-id-conflict' })
          return
        }
        this.duplicates += 1
        sendJson(res, 202, { ok: true, status: 'duplicate', deliveryId: envelope.deliveryId })
        return
      }

      await this.inbox.append({
        t: 'in',
        id: envelope.deliveryId,
        source: envelope.source,
        eventName: envelope.eventName,
        payload: envelope,
        bodyHash,
        receivedAt: Date.now(),
      })

      if (this.config.inbound.eventNames.length > 0 && !this.config.inbound.eventNames.includes(envelope.eventName)) {
        await this.inbox.append({ t: 'ignored', id: envelope.deliveryId, reason: 'event-name-filter' })
        this.ignored += 1
        this.onIgnored?.(envelope.deliveryId)
        sendJson(res, 202, { ok: true, status: 'ignored', deliveryId: envelope.deliveryId })
        return
      }

      this.accepted += 1
      this.onAccepted?.(envelope.deliveryId)
      sendJson(res, 202, { ok: true, status: 'accepted', deliveryId: envelope.deliveryId })
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { ok: false, code: error.code, message: error.message })
        return
      }
      this.lastError = errorMessage(error)
      this.ctx.logger?.error?.(`[erp-bridge] ingress handler failed: ${this.lastError}`)
      sendJson(res, 500, { ok: false, code: 'internal' })
    }
  }
}

function firstHeader(value) {
  return Array.isArray(value) ? value[0] : value
}
