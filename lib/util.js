import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'

/** One structured HTTP failure with a stable machine code. */
export class HttpError extends Error {
  /**
   * @param {number} status HTTP status to answer with.
   * @param {string} code stable lowercase code.
   * @param {string} message human-readable detail (never a secret).
   */
  constructor(status, code, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

/** @param {string | Buffer} value */
export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** @param {string} secret @param {string} payload */
export function hmacHex(secret, payload) {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

/** Constant-time comparison for equal-length lowercase hex strings. */
export function safeEqualHex(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  if (left.length !== right.length || left.length % 2 !== 0) return false
  if (!/^[0-9a-f]+$/.test(left) || !/^[0-9a-f]+$/.test(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

/** Strip common signature prefixes and lowercase one hex signature. */
export function normalizeSignature(raw) {
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim().toLowerCase()
  const value = trimmed.startsWith('sha256=') ? trimmed.slice(7)
    : trimmed.startsWith('v1=') ? trimmed.slice(3)
      : trimmed
  return /^[0-9a-f]+$/.test(value) ? value : ''
}

/** Parse seconds or milliseconds since the epoch into whole seconds. */
export function parseUnixTimestamp(raw) {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return null
  return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value)
}

/** Exponential backoff with bounded jitter, measured from attempt 1. */
export function backoffDelay(attempt, baseMs, maxMs, random = Math.random) {
  const exponent = Math.max(0, Number(attempt) - 1)
  const raw = Math.min(maxMs, baseMs * 2 ** exponent)
  const jitter = raw * 0.25 * Math.max(0, Math.min(1, random()))
  return Math.max(1, Math.min(maxMs, Math.round(raw * 0.75 + jitter)))
}

/** Sleep for one duration, abortable by a signal. */
export function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Truncate a string by code unit, marking the cut explicitly. */
export function truncate(value, max) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/** Collapse whitespace for one-line logs and approval reasons. */
export function oneLine(value, max = 300) {
  return truncate(String(value ?? '').replace(/\s+/g, ' ').trim(), max)
}

/** Stable message from an unknown thrown value. */
export function errorMessage(error) {
  if (error instanceof Error) return error.message
  try {
    return typeof error === 'string' ? error : JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** Read a request body with a hard byte cap. */
export async function readBody(req, maxBytes) {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, 'body-too-large', `request body exceeds ${maxBytes} bytes`)
  }
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > maxBytes) throw new HttpError(413, 'body-too-large', `request body exceeds ${maxBytes} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** Write one JSON response unless headers are already out. */
export function sendJson(res, status, payload, headers = {}) {
  if (res.headersSent || res.writableEnded) return
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(body)
}

const BLOCKED_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
])

const BLOCKED_ADDRESSES = new Set([
  '169.254.169.254',
  '100.100.100.200',
  'fd00:ec2::254',
])

function ipv4Parts(address) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address)
  if (!match) return null
  const parts = match.slice(1).map(Number)
  return parts.every((part) => part >= 0 && part <= 255) ? parts : null
}

function isPrivateAddress(address) {
  const host = address.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host)
  const v4 = mapped ? mapped[1] : host
  const parts = ipv4Parts(v4)
  if (!parts) return false
  const [a, b] = parts
  return a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a === 0
}

/**
 * Validate one configured http(s) URL. Credentials in the authority and
 * cloud-metadata endpoints are always rejected; private networks are allowed
 * only when explicitly configured (on-premise ERP is the common case).
 */
export function assertHttpUrl(raw, { allowPrivateNetwork = true, field = 'url' } = {}) {
  let url
  try {
    url = new URL(String(raw))
  } catch {
    throw new Error(`${field} is not a valid absolute URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${field} must use http: or https:`)
  }
  if (url.username || url.password) {
    throw new Error(`${field} must not embed credentials in the URL`)
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) throw new Error(`${field} has no host`)
  if (BLOCKED_HOSTS.has(host) || BLOCKED_ADDRESSES.has(host)) {
    throw new Error(`${field} points at a cloud-metadata host, which is never allowed`)
  }
  if (!allowPrivateNetwork && isPrivateAddress(host)) {
    throw new Error(`${field} points at a private address while allowPrivateNetwork is false`)
  }
  return url
}

/** Redact values that look like secrets before logging an object. */
export function redact(value, depth = 0) {
  if (value == null || depth > 6) return value
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1))
  if (typeof value !== 'object') return value
  const output = {}
  for (const [key, item] of Object.entries(value)) {
    if (/secret|password|token|authorization|api[-_]?key/i.test(key)) output[key] = '[redacted]'
    else output[key] = redact(item, depth + 1)
  }
  return output
}

/** Short unique id used for generated session ids and request ids. */
export function uniqueId() {
  return randomBytes(16).toString('hex')
}

/** Pick a subset of defined keys. */
export function pick(object, keys) {
  const output = {}
  for (const key of keys) if (object?.[key] !== undefined) output[key] = object[key]
  return output
}

/** Coerce one value into lossless JSON, replacing cycles and bigints. */
export function toJsonValue(value, seen = new WeakSet(), depth = 0) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return value.toString()
  if (typeof value !== 'object') return String(value)
  if (depth > 8) return '[depth-limit]'
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => toJsonValue(item, seen, depth + 1))
  const output = {}
  for (const [key, item] of Object.entries(value)) {
    const converted = toJsonValue(item, seen, depth + 1)
    if (converted !== undefined) output[key] = converted
  }
  return output
}

/** Read at most maxBytes of a fetch response body as UTF-8 text. */
export async function readTextCapped(response, maxBytes = 8192) {
  if (!response?.body?.getReader) return ''
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value?.length) continue
      const remaining = maxBytes - total
      if (remaining <= 0) {
        await reader.cancel().catch(() => {})
        break
      }
      const slice = value.length > remaining ? value.subarray(0, remaining) : value
      chunks.push(slice)
      total += slice.length
      if (total >= maxBytes) {
        await reader.cancel().catch(() => {})
        break
      }
    }
  } catch {
    /* a truncated error body is still useful */
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** True when a signal is already aborted. */
export function isAborted(signal) {
  return Boolean(signal?.aborted)
}

/** Wait for a promise but never longer than a timeout; returns undefined on timeout. */
export async function withTimeout(promise, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Deterministic JSON for hashing. */
export function stableJson(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

/** Test whether a string looks like an absolute URL. */
export function isHttpUrl(value) {
  try {
    const url = new URL(String(value))
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Test an IPv4/IPv6 literal. */
export function isIpLiteral(value) {
  return isIP(String(value).replace(/^\[|\]$/g, '')) !== 0
}
