#!/usr/bin/env node
/**
 * Minimal mock ERP receiver used by the bridge demo and end-to-end tests.
 *
 *   node mock-erp/server.mjs --port 3082 --data-dir ../.dsh-erp-bridge
 *
 * Endpoints:
 *   GET  /health                     receiver state
 *   POST /api/dsh/turn-result        signed DSH -> ERP result (idempotent)
 *   POST /mock/emit                  signed ERP -> DSH event (proxy to ingress)
 *   GET  /mock/state                 received + emitted summaries
 *
 * Failure injection:
 *   --fail 500       every result callback returns 500 (retryable)
 *   --fail 400       every result callback returns 400 (permanent)
 *   --slow 2000      delay every result callback
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, appendFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const port = Number(arg('port', '3082'))
const dataDir = resolve(arg('data-dir', join(process.cwd(), '.dsh-erp-bridge')))
const ingressUrl = arg('ingress', 'http://127.0.0.1:3081/erp/events')
const failStatus = Number(arg('fail', '0'))
const slowMs = Number(arg('slow', '0'))
const secretFile = join(dataDir, 'secret')
const receivedFile = join(dataDir, 'mock-erp-received.jsonl')
const received = new Map()
const emitted = []

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

async function readBody(req, max = 1024 * 1024) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > max) throw new Error('body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function secret() {
  if (process.env.DSH_ERP_HMAC_SECRET) return process.env.DSH_ERP_HMAC_SECRET.trim()
  try {
    return (await readFile(secretFile, 'utf8')).trim()
  } catch {
    throw new Error(`no secret: set DSH_ERP_HMAC_SECRET or create ${secretFile}`)
  }
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false
  try {
    return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
  } catch {
    return false
  }
}

async function verifySignature(headers, raw) {
  const timestamp = String(headers['x-dsh-timestamp'] ?? '')
  const given = String(headers['x-dsh-signature'] ?? '').replace(/^sha256=/, '').toLowerCase()
  if (!timestamp || !given) return false
  const key = await secret()
  const expected = createHmac('sha256', key).update(`${timestamp}.${raw.toString('utf8')}`).digest('hex')
  return safeEqual(expected, given)
}

async function acceptResult(req, res) {
  if (slowMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, slowMs))
  const raw = await readBody(req)
  if (!(await verifySignature(req.headers, raw))) {
    json(res, 401, { ok: false, error: 'bad-signature' })
    return
  }
  if (failStatus >= 400) {
    json(res, failStatus, { ok: false, error: `injected ${failStatus}` })
    return
  }
  const key = String(req.headers['idempotency-key'] ?? '')
  if (!key) {
    json(res, 400, { ok: false, error: 'missing idempotency-key' })
    return
  }
  if (received.has(key)) {
    json(res, 200, { ok: true, duplicate: true, key })
    return
  }
  let payload
  try {
    payload = JSON.parse(raw.toString('utf8'))
  } catch {
    json(res, 400, { ok: false, error: 'bad-json' })
    return
  }
  received.set(key, payload)
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  await appendFile(receivedFile, `${JSON.stringify({ key, receivedAt: Date.now(), payload })}\n`, { mode: 0o600 })
  json(res, 200, { ok: true, key })
}

async function emit(req, res) {
  const raw = await readBody(req)
  const envelope = JSON.parse(raw.toString('utf8'))
  const timestamp = String(Math.floor(Date.now() / 1000))
  const body = JSON.stringify(envelope)
  const key = await secret()
  const signature = createHmac('sha256', key).update(`${timestamp}.${body}`).digest('hex')
  const response = await fetch(ingressUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-erp-timestamp': timestamp,
      'x-erp-signature': signature,
    },
    body,
  })
  const text = await response.text()
  emitted.push({ at: Date.now(), deliveryId: envelope.deliveryId, status: response.status })
  json(res, 200, { ok: response.ok, status: response.status, response: text })
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, {
        ok: true,
        port,
        received: received.size,
        emitted: emitted.length,
        failStatus,
        slowMs,
        dataDir,
        ingressUrl,
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/mock/state') {
      json(res, 200, {
        received: [...received.entries()].slice(-20).map(([key, payload]) => ({ key, status: payload.status, turn: payload.turn, sessionId: payload.sessionId, erp: payload.erp })),
        emitted: emitted.slice(-20),
      })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/dsh/turn-result') {
      await acceptResult(req, res)
      return
    }
    if (req.method === 'POST' && url.pathname === '/mock/emit') {
      await emit(req, res)
      return
    }
    json(res, 404, { ok: false, error: 'not-found' })
  })().catch((error) => {
    json(res, 500, { ok: false, error: error.message })
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[mock-erp] listening on http://127.0.0.1:${port}`)
  console.log(`[mock-erp] data dir ${dataDir}`)
  console.log(`[mock-erp] DSH ingress ${ingressUrl}`)
})
