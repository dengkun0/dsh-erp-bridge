/**
 * End-to-end harness for the bridge internals without a live DSH process:
 * a real HTTP receiver verifies the outbox signature/idempotency/retries, and
 * a fake Session controller exercises the inbound pump's read-only + marker
 * ordering. The live-DSH proof lives in the delivery report and runs against
 * the installed bundle.
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeConfig } from '../lib/config.js'
import { JsonlLedger } from '../lib/ledger.js'
import { SecretStore } from '../lib/secrets.js'
import { MockAdapter } from '../lib/adapters/mock.js'
import { SessionTracker } from '../lib/sessions.js'
import { InboxPump } from '../lib/inbox.js'
import { Outbox } from '../lib/outbox.js'
import { registerTools } from '../lib/tools.js'

const dir = await mkdtemp(join(tmpdir(), 'dsh-erp-bridge-e2e-'))
const logger = { info() {}, warn() {}, error() {}, debug() {} }

function fakeContext() {
  const listeners = new Map()
  const ctx = {
    logger,
    get(name) {
      if (name === 'credentials' || name === 'webServer') return undefined
      return services[name]
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(listener)
      return () => listeners.get(event)?.delete(listener)
    },
    emit(event, ...args) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args)
    },
  }
  const services = {}
  return { ctx, services }
}

class FakeSession {
  constructor(id) {
    this.id = id
    this.events = []
    this.preset = undefined
  }

  snapshotEvents() {
    return this.events
  }

  push(type, data) {
    this.events.push({ type, seq: this.events.length + 1, time: Date.now(), data })
  }
}

function installFakeSessions(ctx, services) {
  const sessions = new Map()
  services.agents = {
    get: (id) => (sessions.has(id) ? { id, session: sessions.get(id) } : undefined),
  }
  services.workingDirectory = { defaultDirectory: dir }
  services.permissionPresets = {
    set(session, preset) { session.preset = preset },
    current(session) { return session.preset },
  }
  services.sessionController = {
    async inspect(sessionId) {
      const session = sessions.get(sessionId)
      if (!session) throw new Error('session not found')
      return { events: session.snapshotEvents() }
    },
    async create({ sessionId }) {
      const session = new FakeSession(sessionId)
      sessions.set(sessionId, session)
      ctx.emit('session/created', session)
      return { sessionId }
    },
    async prompt({ sessionId, requestId, content }) {
      const session = sessions.get(sessionId)
      if (!session) throw new Error('session not found')
      const text = content.map((part) => part.text ?? '').join('')
      session.push('user/message', { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' }, id: requestId })
      ctx.emit('session/event', session, session.events.at(-1))
      return { accepted: true }
    },
  }
  return sessions
}

let receiverMode = 'ok'
const received = new Map()
let receiverSecret = ''

const receiver = createServer((req, res) => {
  void (async () => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks)
    const timestamp = String(req.headers['x-dsh-timestamp'] ?? '')
    const given = String(req.headers['x-dsh-signature'] ?? '').replace(/^sha256=/, '')
    const expected = createHmac('sha256', receiverSecret).update(`${timestamp}.${raw.toString('utf8')}`).digest('hex')
    if (given !== expected) {
      res.writeHead(401).end('bad signature')
      return
    }
    if (receiverMode === 'fail-400') {
      res.writeHead(400).end('injected permanent failure')
      return
    }
    if (receiverMode === 'fail-503-2') {
      const key = String(req.headers['idempotency-key'])
      const item = received.get(key) ?? { attempts: 0, payload: undefined }
      item.attempts += 1
      received.set(key, item)
      if (item.attempts <= 2) {
        res.writeHead(503).end('injected transient failure')
        return
      }
    }
    const key = String(req.headers['idempotency-key'] ?? '')
    const payload = JSON.parse(raw.toString('utf8'))
    const item = received.get(key) ?? { attempts: 0, payload }
    item.attempts += 1
    item.payload = payload
    received.set(key, item)
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }))
  })().catch((error) => res.writeHead(500).end(error.message))
})
await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve))
const receiverPort = receiver.address().port
const targetUrl = `http://127.0.0.1:${receiverPort}/api/dsh/turn-result`

function waitFor(predicate, timeoutMs = 8000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) resolve()
      else if (Date.now() - start > timeoutMs) reject(new Error('timed out'))
      else setTimeout(tick, 50)
    }
    tick()
  })
}

function makeSessionEvents(id) {
  const session = new FakeSession(id)
  session.push('turn/start', { turn: 1 })
  session.push('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'erp_query', arguments: '{"entity":"purchase_order"}' })
  session.push('tool/result', { turn: 1, step: 1, message: { toolCallId: 'c1', role: 'tool', content: [] } })
  session.push('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '查到 1 张采购订单。' }] } })
  session.push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session
}

try {
  const { ctx, services } = fakeContext()
  const configResult = normalizeConfig({
    dataDir: dir,
    adapter: { id: 'mock' },
    ingress: { enabled: false },
    inbound: { enabled: false },
    outbound: {
      enabled: true,
      targetUrl,
      scope: 'erp-tools',
      baseDelayMs: 100,
      maxDelayMs: 400,
      maxAttempts: 4,
      pollIntervalMs: 100,
      timeoutMs: 3000,
    },
  })
  const config = configResult.config
  const secrets = new SecretStore(ctx, dir)
  receiverSecret = (await secrets.resolve(config.outbound.signature.secretRef)).value
  const ledger = new JsonlLedger(join(dir, 'outbox.jsonl'), 'outbox')
  await ledger.open()
  const tracker = new SessionTracker(ctx)
  tracker.start()
  const outbox = new Outbox({ ctx, config, ledger, adapter: new MockAdapter(), secrets, tracker })
  outbox.start()
  try {
    const session = makeSessionEvents('session-1')
    outbox.onSessionEvent(session, session.events.at(-1))
    const id = 'session-1:1'
    await waitFor(() => ledger.get(id)?.state === 'done')
    assert.equal(received.get(id).payload.summary, '查到 1 张采购订单。')
    assert.equal(received.get(id).payload.toolCalls[0].name, 'erp_query')
    assert.equal(received.get(id).payload.status, 'completed')
    console.log('✔ outbox delivered a signed, idempotent turn.end')

    receiverMode = 'fail-503-2'
    const retried = makeSessionEvents('session-2')
    outbox.onSessionEvent(retried, retried.events.at(-1))
    const retryId = 'session-2:1'
    await waitFor(() => ledger.get(retryId)?.state === 'done')
    assert.ok(ledger.get(retryId).attempts >= 2, 'expected at least two retry attempts')
    assert.ok(received.get(retryId).attempts >= 3, 'receiver should observe the retries')
    console.log('✔ outbox retried 503 twice and then delivered')

    receiverMode = 'fail-400'
    const permanent = makeSessionEvents('session-3')
    outbox.onSessionEvent(permanent, permanent.events.at(-1))
    const failedId = 'session-3:1'
    await waitFor(() => ledger.get(failedId)?.state === 'failed')
    assert.match(ledger.get(failedId).error, /HTTP 400/)
    console.log('✔ outbox treated 400 as permanent, no retry')

    const linkedConfig = normalizeConfig({
      dataDir: dir,
      adapter: { id: 'mock' },
      ingress: { enabled: false },
      inbound: { enabled: false },
      outbound: { enabled: true, targetUrl, scope: 'linked', pollIntervalMs: 100, baseDelayMs: 100, maxDelayMs: 400 },
    }).config
    const linkedLedger = new JsonlLedger(join(dir, 'outbox-linked.jsonl'), 'outbox')
    await linkedLedger.open()
    const linkedTracker = new SessionTracker(ctx)
    linkedTracker.start()
    const linkedOutbox = new Outbox({ ctx, config: linkedConfig, ledger: linkedLedger, adapter: new MockAdapter(), secrets, tracker: linkedTracker })
    linkedOutbox.start()
    try {
      const unlinked = makeSessionEvents('session-unlinked')
      linkedOutbox.onSessionEvent(unlinked, unlinked.events.at(-1))
      await new Promise((resolve) => setTimeout(resolve, 300))
      assert.equal(linkedLedger.get('session-unlinked:1'), undefined)
      console.log('✔ linked scope ignores a session that did not originate in ERP')
    } finally {
      await linkedOutbox.stop()
      linkedTracker.stop()
    }
  } finally {
    await outbox.stop()
    tracker.stop()
  }

  const toolDefs = []
  const approvalOutcomes = []
  const toolCtx = {
    logger,
    get(name) {
      if (name === 'approval') {
        return { request: async () => approvalOutcomes.shift() ?? 'unavailable' }
      }
      return services[name]
    },
    tools: {
      register(definition) {
        toolDefs.push(definition)
        return () => {}
      },
    },
  }
  const writeConfig = normalizeConfig({
    dataDir: dir,
    adapter: { id: 'mock' },
    ingress: { enabled: false },
    inbound: { enabled: false },
    outbound: { enabled: false },
    policy: { allowWrite: true, writableEntities: ['purchase_order'] },
  }).config
  const writeAdapter = new MockAdapter()
  registerTools({
    ctx: toolCtx,
    config: writeConfig,
    adapter: writeAdapter,
    inbox: { ledger: { list: () => [], stats: () => ({ entries: 0, counts: {} }) }, status: () => ({}), retry: async () => ({}) },
    outbox: { ledger: { list: () => [], stats: () => ({ entries: 0, counts: {} }) }, status: () => ({}) },
    tracker: { get: () => undefined, inboundFor: () => undefined },
    secrets,
    ingress: { status: () => ({}) },
  })
  const draftTool = toolDefs.find((definition) => definition.name === 'erp_create_draft')
  const commitTool = toolDefs.find((definition) => definition.name === 'erp_commit')
  assert.ok(draftTool && commitTool, 'write tools should be registered when allowWrite is true')
  const exec = { agent: { id: 'write-session' }, callId: 'call-1', signal: new AbortController().signal }
  approvalOutcomes.push('allowed-once')
  const created = await draftTool.execute({ entity: 'purchase_order', data: { vendor: 'V-001', amount: 99, currency: 'CNY' } }, exec)
  assert.match(created.docId, /^DRAFT-/)
  approvalOutcomes.push('rejected')
  await assert.rejects(() => draftTool.execute({ entity: 'purchase_order', data: { vendor: 'V-001', amount: 100, currency: 'CNY' } }, exec), /approval rejected/)
  const after = await writeAdapter.query('purchase_order', {}, {})
  assert.equal(after.total, 3, 'a rejected approval must not create a second draft')
  console.log('✔ write tools are registered only with allowWrite and require allowed-once approval')

  const readOnlyDefs = []
  const readOnlyCtx = {
    logger,
    get: () => undefined,
    tools: { register(definition) { readOnlyDefs.push(definition); return () => {} } },
  }
  registerTools({
    ctx: readOnlyCtx,
    config: normalizeConfig({ dataDir: dir, adapter: { id: 'mock' }, ingress: { enabled: false }, inbound: { enabled: false }, outbound: { enabled: false } }).config,
    adapter: new MockAdapter(),
    inbox: { ledger: { list: () => [], stats: () => ({ entries: 0, counts: {} }) }, status: () => ({}), retry: async () => ({}) },
    outbox: { ledger: { list: () => [], stats: () => ({ entries: 0, counts: {} }) }, status: () => ({}) },
    tracker: { get: () => undefined, inboundFor: () => undefined },
    secrets,
    ingress: { status: () => ({}) },
  })
  assert.equal(readOnlyDefs.some((definition) => definition.name === 'erp_create_draft'), false)
  console.log('✔ write tools are absent from the registry when allowWrite is false')

  const { ctx: inboundCtx, services: inboundServices } = fakeContext()
  installFakeSessions(inboundCtx, inboundServices)
  const inboundConfig = normalizeConfig({
    dataDir: dir,
    adapter: { id: 'mock' },
    ingress: { enabled: false },
    outbound: { enabled: false },
    inbound: { enabled: true, pollIntervalMs: 100, retryBaseMs: 100, retryMaxMs: 500, maxAttempts: 3 },
  }).config
  const inboundLedger = new JsonlLedger(join(dir, 'inbox.jsonl'), 'inbox')
  await inboundLedger.open()
  const inboundTracker = new SessionTracker(inboundCtx)
  inboundTracker.start()
  const pump = new InboxPump({ ctx: inboundCtx, config: inboundConfig, ledger: inboundLedger, tracker: inboundTracker })
  pump.start()
  try {
    await inboundLedger.append({
      t: 'in',
      id: 'delivery-1',
      source: 'kingdee',
      eventName: 'purchase_order.approved',
      payload: { deliveryId: 'delivery-1', eventName: 'purchase_order.approved', source: 'kingdee', entity: { type: 'purchase_order', id: 'PO-2026-0001' } },
      bodyHash: 'hash',
      receivedAt: Date.now(),
    })
    pump.kick()
    await waitFor(() => inboundLedger.get('delivery-1')?.state === 'prompted')
    const entry = inboundLedger.get('delivery-1')
    const fakeSession = [...(inboundTracker.sessions.values())][0]
    assert.ok(fakeSession, 'a session should have been published')
    assert.equal(fakeSession.preset, 'read-only')
    const userMessage = fakeSession.events.find((event) => event.type === 'user/message')
    assert.match(userMessage.data.content[0].text, /\[erp-bridge:delivery-1\]/)
    assert.match(userMessage.data.content[0].text, /untrusted data/)
    assert.equal(entry.sessionId, fakeSession.id)
    assert.ok(inboundTracker.inboundFor(fakeSession.id))
    console.log('✔ inbound pump applied read-only, admitted one marked prompt, linked the session')
  } finally {
    await pump.stop()
    inboundTracker.stop()
  }
} finally {
  await new Promise((resolve) => receiver.close(resolve))
  await rm(dir, { recursive: true, force: true })
}

console.log('e2e harness passed')
