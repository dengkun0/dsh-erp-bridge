import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { createHmac } from 'node:crypto'

import { foldInbox, foldOutbox, JsonlLedger } from '../lib/ledger.js'
import { normalizeConfig, renderPrompt, validateEnvelope } from '../lib/config.js'
import { MockAdapter } from '../lib/adapters/mock.js'
import { Ingress } from '../lib/ingress.js'
import { SecretStore } from '../lib/secrets.js'
import {
  assertHttpUrl,
  backoffDelay,
  hmacHex,
  normalizeSignature,
  parseUnixTimestamp,
  safeEqualHex,
} from '../lib/util.js'

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'dsh-erp-bridge-test-'))
}

test('inbox fold keeps one state per delivery and never regresses a prompt', () => {
  const entries = foldInbox([
    { t: 'in', id: 'd1', source: 'kingdee', eventName: 'po.approved', payload: { deliveryId: 'd1' }, bodyHash: 'aa', receivedAt: 1 },
    { t: 'sid', id: 'd1', sessionId: 's1' },
    { t: 'attempt', id: 'd1', attempts: 1, nextAt: 5, error: 'boom' },
    { t: 'prompted', id: 'd1', sessionId: 's1' },
    { t: 'attempt', id: 'd1', attempts: 2, nextAt: 9, error: 'late' },
  ])
  const entry = entries.get('d1')
  assert.equal(entry.state, 'prompted')
  assert.equal(entry.sessionId, 's1')
  assert.equal(entry.attempts, 2)
  assert.equal(entry.error, undefined)
})

test('outbox fold distinguishes pending, retry, done and permanent failure', () => {
  const entries = foldOutbox([
    { t: 'put', id: 's1:1', idempotencyKey: 's1:1', payload: { ok: true }, target: 'http://x', at: 1 },
    { t: 'attempt', id: 's1:1', attempts: 1, nextAt: 10, status: 503 },
    { t: 'retry', id: 's1:1' },
    { t: 'done', id: 's1:1', status: 200, at: 20 },
    { t: 'put', id: 's1:2', payload: {}, target: 'http://x', at: 2 },
    { t: 'failed', id: 's1:2', error: 'HTTP 400', status: 400 },
  ])
  assert.equal(entries.get('s1:1').state, 'done')
  assert.equal(entries.get('s1:1').attempts, 0)
  assert.equal(entries.get('s1:2').state, 'failed')
})

test('JSONL ledger survives reopen and ignores one truncated tail', async () => {
  const dir = await tempDir()
  try {
    const file = join(dir, 'inbox.jsonl')
    const ledger = new JsonlLedger(file, 'inbox')
    await ledger.open()
    await ledger.append({ t: 'in', id: 'a', payload: { x: 1 }, receivedAt: 1 })
    await ledger.append({ t: 'sid', id: 'a', sessionId: 's' })
    await ledger.append({ t: 'prompted', id: 'a', sessionId: 's' })
    const reopened = new JsonlLedger(file, 'inbox')
    const info = await reopened.open()
    assert.equal(info.entries, 1)
    assert.equal(reopened.get('a').state, 'prompted')
    const text = await readFile(file, 'utf8')
    const incomplete = new JsonlLedger(file, 'inbox')
    await rm(file)
    await import('node:fs/promises').then(({ writeFile }) => writeFile(file, `${text}{"t":"in"`))
    await incomplete.open()
    assert.equal(incomplete.get('a').state, 'prompted')
    assert.equal(incomplete.corrupt, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('config defaults and validation are explicit', () => {
  const { config } = normalizeConfig({ dataDir: 'x', adapter: { id: 'mock' }, outbound: { enabled: false } })
  assert.equal(config.ingress.mode, 'standalone')
  assert.equal(config.inbound.permissionPreset, 'read-only')
  assert.equal(config.policy.allowWrite, false)
  assert.equal(config.outbound.scope, 'linked')
  assert.throws(() => normalizeConfig({ adapter: { id: 'nope' } }), /adapter.id/)
  assert.throws(() => normalizeConfig({ outbound: { enabled: true } }), /targetUrl/)
})

test('prompt rendering keeps the untrusted-data marker and replaces every value', () => {
  const text = renderPrompt('{{deliveryId}}|{{source}}|{{eventName}}|{{entityType}}/{{entityId}}|{{eventJson}}', {
    deliveryId: 'd1', source: 's', eventName: 'e', entityType: 'po', entityId: '1', eventJson: '{}',
  })
  assert.equal(text, 'd1|s|e|po/1|{}')
})

test('envelope validation rejects missing identity and keeps unknown fields', () => {
  const envelope = validateEnvelope({ deliveryId: 'd1', eventName: 'po.approved', entity: { type: 'po', id: '1', extra: true }, data: { amount: 1 } })
  assert.equal(envelope.entity.extra, true)
  assert.throws(() => validateEnvelope({ eventName: 'x' }), /deliveryId/)
  assert.throws(() => validateEnvelope({ deliveryId: 'd1' }), /eventName/)
})

test('HMAC helpers reject malformed and mismatched signatures', () => {
  const secret = 'a'.repeat(32)
  const signature = hmacHex(secret, '1.{}')
  assert.equal(signature.length, 64)
  assert.equal(safeEqualHex(signature, signature), true)
  assert.equal(safeEqualHex(signature, `${signature}0`), false)
  assert.equal(normalizeSignature(`sha256=${signature.toUpperCase()}`), signature)
  assert.equal(normalizeSignature('nope'), '')
  const raw = createHmac('sha256', secret).update('1.{}').digest('hex')
  assert.equal(raw, signature)
})

test('timestamp parsing accepts seconds and milliseconds', () => {
  assert.equal(parseUnixTimestamp('1700000000'), 1700000000)
  assert.equal(parseUnixTimestamp('1700000000000'), 1700000000)
  assert.equal(parseUnixTimestamp('nope'), null)
})

test('backoff grows, stays under the cap, and keeps jitter bounded', () => {
  const values = [1, 2, 3, 4, 5].map((attempt) => backoffDelay(attempt, 1000, 10000, () => 0))
  assert.deepEqual(values.slice(0, 4), [750, 1500, 3000, 6000])
  assert.ok(values.every((value) => value <= 10000))
  assert.ok(backoffDelay(20, 1000, 10000) <= 10000)
})

test('configured URLs reject metadata endpoints and embedded credentials', () => {
  assert.ok(assertHttpUrl('http://127.0.0.1:3082/x'))
  assert.throws(() => assertHttpUrl('http://169.254.169.254/latest/meta-data'), /metadata/)
  assert.throws(() => assertHttpUrl('http://user:pass@example.com/'), /credentials/)
  assert.throws(() => assertHttpUrl('ftp://example.com/'), /http/)
})

test('mock adapter enforces field and write allow-lists', async () => {
  const adapter = new MockAdapter()
  const result = await adapter.query('purchase_order', { status: 'approved' }, { fields: ['id', 'amount'] })
  assert.equal(result.total, 1)
  assert.deepEqual(Object.keys(result.rows[0]).sort(), ['amount', 'id'])
  await assert.rejects(() => adapter.query('purchase_order', {}, { fields: ['secret'] }), /not exposed/)
  await assert.rejects(() => adapter.query('missing', {}), /unknown entity/)
  const draft = await adapter.createDraft('purchase_order', { vendor: 'V-001', amount: 10, currency: 'CNY' })
  assert.match(draft.docId, /^DRAFT-/)
  const committed = await adapter.commit('purchase_order', draft.docId)
  assert.equal(committed.state, 'approved')
  await assert.rejects(() => adapter.commit('sales_order', 'SO-2026-0101'), /read-only/)
})

test('standalone ingress verifies HMAC, deduplicates, and rejects conflicts', async () => {
  const dir = await tempDir()
  const ledger = new JsonlLedger(join(dir, 'inbox.jsonl'), 'inbox')
  await ledger.open()
  const secrets = new SecretStore({ get: () => undefined, logger: {} }, dir)
  const accepted = []
  const { config } = normalizeConfig({
    dataDir: dir,
    adapter: { id: 'mock' },
    ingress: { enabled: true, mode: 'standalone', host: '127.0.0.1', port: 0, path: '/erp/events' },
    inbound: { enabled: false },
    outbound: { enabled: false },
  })
  const ingress = new Ingress({
    ctx: { get: () => undefined, logger: { info() {}, warn() {}, error() {}, debug() {} } },
    config,
    secrets,
    inbox: ledger,
    onAccepted: (id) => accepted.push(id),
    onIgnored: () => {},
  })
  await ingress.start()
  try {
    const secret = (await secrets.resolve(config.ingress.signature.secretRef)).value
    const url = `http://127.0.0.1:${ingress.port}/erp/events`
    const body = JSON.stringify({ deliveryId: 'd1', eventName: 'po.approved', entity: { type: 'purchase_order', id: 'PO-1' }, data: { amount: 1 } })
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
    const send = (payload = body, ts = timestamp, sig = signature) => fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-erp-timestamp': ts, 'x-erp-signature': sig },
      body: payload,
    })
    const first = await send()
    assert.equal(first.status, 202)
    assert.equal((await first.json()).status, 'accepted')
    assert.equal(accepted.length, 1)
    const duplicate = await send()
    assert.equal(duplicate.status, 202)
    assert.equal((await duplicate.json()).status, 'duplicate')
    const spaced = JSON.stringify(JSON.parse(body), null, 2)
    const spacedSig = createHmac('sha256', secret).update(`${timestamp}.${spaced}`).digest('hex')
    const whitespaceDuplicate = await send(spaced, timestamp, spacedSig)
    assert.equal(whitespaceDuplicate.status, 202)
    assert.equal((await whitespaceDuplicate.json()).status, 'duplicate')
    assert.equal((await send(body, timestamp, '0'.repeat(64))).status, 401)
    assert.equal((await send(body, '1', signature)).status, 401)
    const conflictBody = JSON.stringify({ deliveryId: 'd1', eventName: 'po.approved', entity: { type: 'purchase_order', id: 'PO-2' } })
    const conflictSig = createHmac('sha256', secret).update(`${timestamp}.${conflictBody}`).digest('hex')
    assert.equal((await send(conflictBody, timestamp, conflictSig)).status, 409)
    const health = await fetch(`http://127.0.0.1:${ingress.port}/erp/health`)
    assert.equal(health.status, 200)
    assert.equal((await health.json()).ok, true)
  } finally {
    await ingress.stop()
    await rm(dir, { recursive: true, force: true })
  }
})
