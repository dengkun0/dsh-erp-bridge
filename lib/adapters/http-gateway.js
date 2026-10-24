import { assertHttpUrl, errorMessage, truncate } from '../util.js'

function normalizeEntityPolicy(value) {
  if (Array.isArray(value)) return { fields: value.filter((field) => typeof field === 'string'), writable: false }
  if (value && typeof value === 'object') {
    return {
      fields: Array.isArray(value.fields) ? value.fields.filter((field) => typeof field === 'string') : [],
      writable: value.writable === true,
    }
  }
  return { fields: [], writable: false }
}

/**
 * Adapter for a thin customer-owned HTTP gateway in front of a legacy ERP.
 * The gateway contract is intentionally small and is documented in
 * docs/adapter-contract.md: query, document, draft, commit, health.
 */
export class HttpGatewayAdapter {
  constructor(config, { secrets }) {
    this.id = 'http-gateway'
    this.config = config
    this.secrets = secrets
    this.baseUrl = assertHttpUrl(config.baseUrl, { allowPrivateNetwork: true, field: 'adapter.baseUrl' }).toString().replace(/\/$/, '')
    this.entities = Object.fromEntries(Object.entries(config.entities).map(([entity, value]) => [entity, normalizeEntityPolicy(value)]))
  }

  entityNames() {
    return Object.keys(this.entities)
  }

  entityPolicy(entity) {
    const policy = this.entities[entity]
    if (!policy) throw new Error(`unknown entity "${entity}"; configure adapter.entities.${entity}`)
    if (policy.fields.length === 0) throw new Error(`adapter.entities.${entity}.fields is required`)
    return policy
  }

  path(template, entity, id) {
    return template
      .replaceAll('{entity}', encodeURIComponent(entity))
      .replaceAll('{id}', encodeURIComponent(String(id)))
  }

  async headers() {
    const headers = { accept: 'application/json' }
    if (!this.config.authRef) return headers
    const resolved = await this.secrets.resolve(this.config.authRef, { autoGenerate: false })
    headers[this.config.authHeader] = this.config.authScheme
      ? `${this.config.authScheme} ${resolved.value}`
      : resolved.value
    return headers
  }

  async request(method, path, body, signal) {
    const timeout = AbortSignal.timeout(this.config.timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    let response
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { ...(await this.headers()), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: combined,
        redirect: 'error',
      })
    } catch (error) {
      throw new Error(`ERP gateway request failed: ${errorMessage(error)}`)
    }
    const text = await response.text()
    let parsed
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      throw new Error(`ERP gateway returned non-JSON HTTP ${response.status}: ${truncate(text, 300)}`)
    }
    if (!response.ok) {
      const detail = parsed?.error ?? parsed?.message ?? truncate(text, 300)
      throw new Error(`ERP gateway HTTP ${response.status}: ${detail}`)
    }
    return parsed
  }

  async query(entity, filter = {}, options = {}, signal) {
    const policy = this.entityPolicy(entity)
    const fields = options.fields?.length ? options.fields : policy.fields
    for (const field of fields) if (!policy.fields.includes(field)) throw new Error(`field "${field}" is not exposed for ${entity}`)
    const result = await this.request('POST', this.config.paths.query, {
      entity,
      filter,
      fields,
      limit: options.limit,
      offset: options.offset,
    }, signal)
    const rows = Array.isArray(result) ? result : result?.rows ?? []
    const trimmed = rows.map((row) => Object.fromEntries(fields.filter((field) => row[field] !== undefined).map((field) => [field, row[field]])))
    return { entity, rows: trimmed, total: result?.total ?? rows.length, fields, source: 'gateway' }
  }

  async get(entity, id, signal) {
    const policy = this.entityPolicy(entity)
    const result = await this.request('GET', this.path(this.config.paths.document, entity, id), undefined, signal)
    if (!result) return null
    const doc = result.doc ?? result
    return Object.fromEntries(policy.fields.filter((field) => doc[field] !== undefined).map((field) => [field, doc[field]]))
  }

  async createDraft(entity, data, signal) {
    const policy = this.entityPolicy(entity)
    if (!policy.writable) throw new Error(`${entity} is not writable in the http-gateway adapter`)
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('data must be an object')
    for (const key of Object.keys(data)) if (!policy.fields.includes(key)) throw new Error(`field "${key}" is not exposed for ${entity}`)
    const result = await this.request('POST', this.config.paths.draft, { entity, data }, signal)
    const docId = result?.docId ?? result?.id
    if (!docId) throw new Error('ERP gateway draft response did not include docId')
    return { docId: String(docId), doc: result?.doc }
  }

  async commit(entity, id, data = {}, signal) {
    const policy = this.entityPolicy(entity)
    if (!policy.writable) throw new Error(`${entity} is not writable in the http-gateway adapter`)
    const result = await this.request('POST', this.path(this.config.paths.commit, entity, id), { data }, signal)
    return { docId: String(id), state: result?.state ?? 'committed', doc: result?.doc, result }
  }

  async pollChanges(since = 0, signal) {
    if (!this.config.paths.changes) return []
    const result = await this.request('GET', `${this.config.paths.changes}?since=${encodeURIComponent(since)}`, undefined, signal)
    return Array.isArray(result) ? result : result?.changes ?? []
  }

  async health(signal) {
    const result = await this.request('GET', this.config.paths.health, undefined, signal)
    return { ok: true, adapter: 'http-gateway', baseUrl: this.baseUrl, ...(result ?? {}) }
  }

  async buildResultWrite() {
    return null
  }
}
