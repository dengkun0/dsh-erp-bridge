import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Fold append-only inbox facts into one current state per delivery. */
export function foldInbox(records) {
  const entries = new Map()
  for (const record of records) {
    if (!record || typeof record !== 'object' || typeof record.id !== 'string') continue
    if (record.t === 'snapshot' && record.entry && typeof record.entry === 'object') {
      entries.set(record.id, { ...record.entry })
      continue
    }
    const existing = entries.get(record.id)
    switch (record.t) {
      case 'in': {
        if (existing) break
        entries.set(record.id, {
          id: record.id,
          state: 'received',
          source: record.source ?? '',
          eventName: record.eventName ?? '',
          payload: record.payload ?? {},
          bodyHash: record.bodyHash ?? '',
          receivedAt: record.receivedAt ?? record.at ?? 0,
          attempts: 0,
          nextAt: 0,
        })
        break
      }
      case 'sid': {
        if (!existing) break
        existing.sessionId = record.sessionId
        if (existing.state === 'received') existing.state = 'session-created'
        break
      }
      case 'session': {
        if (!existing) break
        existing.sessionId = record.sessionId ?? existing.sessionId
        existing.state = 'session-created'
        break
      }
      case 'attempt': {
        if (!existing) break
        existing.attempts = Math.max(existing.attempts ?? 0, Number(record.attempts) || 0)
        existing.nextAt = Number(record.nextAt) || 0
        if (record.error) existing.lastError = String(record.error)
        if (existing.state === 'received' || existing.state === 'session-created') existing.state = 'received'
        break
      }
      case 'prompted': {
        if (!existing) break
        existing.state = 'prompted'
        existing.promptedAt = record.at ?? 0
        existing.sessionId = record.sessionId ?? existing.sessionId
        existing.error = undefined
        existing.lastError = undefined
        break
      }
      case 'ignored': {
        if (!existing) break
        existing.state = 'ignored'
        existing.reason = record.reason ?? 'filtered'
        existing.ignoredAt = record.at ?? 0
        break
      }
      case 'failed': {
        if (!existing) break
        existing.state = 'failed'
        existing.error = record.error ?? 'unknown'
        existing.failedAt = record.at ?? 0
        break
      }
      case 'retry': {
        if (!existing) break
        existing.state = 'received'
        existing.attempts = 0
        existing.nextAt = 0
        existing.error = undefined
        existing.lastError = undefined
        existing.failedAt = undefined
        break
      }
      default: break
    }
  }
  return entries
}

/** Fold append-only outbox facts into one current state per delivery. */
export function foldOutbox(records) {
  const entries = new Map()
  for (const record of records) {
    if (!record || typeof record !== 'object' || typeof record.id !== 'string') continue
    if (record.t === 'snapshot' && record.entry && typeof record.entry === 'object') {
      entries.set(record.id, { ...record.entry })
      continue
    }
    const existing = entries.get(record.id)
    switch (record.t) {
      case 'put': {
        if (existing) break
        entries.set(record.id, {
          id: record.id,
          state: 'pending',
          idempotencyKey: record.idempotencyKey ?? record.id,
          payload: record.payload ?? {},
          target: record.target ?? '',
          headers: record.headers && typeof record.headers === 'object' ? record.headers : undefined,
          createdAt: record.at ?? Date.now(),
          attempts: 0,
          nextAt: 0,
        })
        break
      }
      case 'attempt': {
        if (!existing) break
        existing.attempts = Math.max(existing.attempts ?? 0, Number(record.attempts) || 0)
        existing.nextAt = Number(record.nextAt) || 0
        existing.lastError = record.error ? String(record.error) : existing.lastError
        existing.lastStatus = record.status ?? existing.lastStatus
        break
      }
      case 'done': {
        if (!existing) break
        existing.state = 'done'
        existing.doneAt = record.at ?? 0
        existing.status = record.status ?? existing.status
        existing.lastError = undefined
        break
      }
      case 'failed': {
        if (!existing) break
        existing.state = 'failed'
        existing.failedAt = record.at ?? 0
        existing.error = record.error ?? 'unknown'
        break
      }
      case 'retry': {
        if (!existing) break
        existing.state = 'pending'
        existing.attempts = 0
        existing.nextAt = 0
        existing.error = undefined
        existing.lastError = undefined
        existing.failedAt = undefined
        break
      }
      default: break
    }
  }
  return entries
}

function parseLines(text) {
  const records = []
  let corrupt = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      records.push(JSON.parse(trimmed))
    } catch {
      corrupt += 1
    }
  }
  return { records, corrupt }
}

/**
 * Append-only JSONL ledger. Every write is one fact; state is always the fold
 * of the file. A crash can lose at most the last partial line, which is
 * ignored on the next open.
 */
export class JsonlLedger {
  /**
   * @param {string} file absolute JSONL path.
   * @param {'inbox'|'outbox'} kind fold family.
   * @param {{maxBytes?: number, keepDone?: number}} options
   */
  constructor(file, kind, options = {}) {
    this.file = file
    this.kind = kind
    this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024
    this.keepDone = options.keepDone ?? 500
    this.entries = new Map()
    this.bytes = 0
    this.corrupt = 0
    this.ready = false
    this.writeChain = Promise.resolve()
  }

  async open() {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    let text = ''
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      await writeFile(this.file, '', { mode: 0o600 })
    }
    const { records, corrupt } = parseLines(text)
    this.corrupt = corrupt
    this.bytes = Buffer.byteLength(text)
    this.entries = this.kind === 'inbox' ? foldInbox(records) : foldOutbox(records)
    this.ready = true
    if (this.bytes > this.maxBytes) await this.compact()
    return { entries: this.entries.size, bytes: this.bytes, corrupt }
  }

  /** Append one fact and wait until the OS accepted the bytes. */
  async append(record) {
    if (!this.ready) throw new Error('ledger is not open')
    const line = `${JSON.stringify({ ...record, at: record.at ?? Date.now() })}\n`
    const run = this.writeChain.then(() => appendFile(this.file, line, { mode: 0o600 }))
    this.writeChain = run.catch(() => {})
    await run
    this.bytes += Buffer.byteLength(line)
    if (record.id) {
      const current = this.entries.get(record.id)
      const seed = current ? [{ t: 'snapshot', id: record.id, entry: current }, record] : [record]
      const next = this.kind === 'inbox' ? foldInbox(seed).get(record.id) : foldOutbox(seed).get(record.id)
      if (next) this.entries.set(record.id, next)
    }
    if (this.bytes > this.maxBytes) void this.compact().catch(() => {})
  }

  list() {
    return [...this.entries.values()]
  }

  get(id) {
    return this.entries.get(id)
  }

  stats() {
    const counts = {}
    for (const entry of this.entries.values()) counts[entry.state] = (counts[entry.state] ?? 0) + 1
    return {
      file: this.file,
      bytes: this.bytes,
      entries: this.entries.size,
      counts,
      corrupt: this.corrupt,
    }
  }

  /**
   * Rewrite the log as one snapshot per retained entry. Pending and failed
   * entries always survive; older completed entries are bounded by keepDone.
   */
  async compact() {
    const run = this.writeChain.then(async () => {
      const all = [...this.entries.values()]
      const completed = all
        .filter((entry) => this.kind === 'inbox' ? entry.state === 'prompted' || entry.state === 'ignored' : entry.state === 'done')
        .sort((left, right) => (right.promptedAt ?? right.doneAt ?? right.ignoredAt ?? 0) - (left.promptedAt ?? left.doneAt ?? left.ignoredAt ?? 0))
      const keep = new Set(completed.slice(0, this.keepDone).map((entry) => entry.id))
      const kept = all.filter((entry) => !(this.kind === 'inbox' ? entry.state === 'prompted' || entry.state === 'ignored' : entry.state === 'done') || keep.has(entry.id))
      const temp = `${this.file}.tmp-${process.pid}-${Date.now()}`
      const text = kept.map((entry) => JSON.stringify({ t: 'snapshot', id: entry.id, entry, at: Date.now() })).join('\n')
      await writeFile(temp, text ? `${text}\n` : '', { mode: 0o600 })
      await rename(temp, this.file)
      this.bytes = Buffer.byteLength(text ? `${text}\n` : '')
      return { kept: kept.length, dropped: all.length - kept.length, bytes: this.bytes }
    })
    this.writeChain = run.catch(() => {})
    return run
  }
}

/** Create the two ledgers under one data directory. */
export function ledgerPaths(dataDir) {
  return {
    inbox: join(dataDir, 'inbox.jsonl'),
    outbox: join(dataDir, 'outbox.jsonl'),
    secret: join(dataDir, 'secret'),
  }
}
