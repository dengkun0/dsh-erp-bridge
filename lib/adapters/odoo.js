import { assertHttpUrl, errorMessage, sha256Hex, truncate } from '../util.js'

/**
 * Odoo JSON-RPC adapter. Authentication is performed per operation (with a
 * short-lived uid cache) so a rotated password reaches the next call without a
 * restart. Only models and fields named in the config are reachable.
 */
export class OdooAdapter {
  /**
   * @param {object} config normalized adapter config.
   * @param {{secrets: import('../secrets.js').SecretStore}} deps
   */
  constructor(config, { secrets }) {
    this.id = 'odoo'
    this.config = config
    this.secrets = secrets
    this.url = assertHttpUrl(config.url, { allowPrivateNetwork: true, field: 'adapter.url' }).toString().replace(/\/$/, '')
    this.rpcId = 0
    this.cache = undefined
  }

  entityNames() {
    return Object.keys(this.config.models)
  }

  entityPolicy(entity) {
    const model = this.config.models[entity]
    if (!model) throw new Error(`unknown entity "${entity}"; available: ${this.entityNames().join(', ')}`)
    const fields = this.config.fields[entity]?.length ? this.config.fields[entity] : ['id', 'display_name']
    return { model, fields, writable: Boolean(this.config.writable[entity]) }
  }

  async password() {
    const resolved = await this.secrets.resolve(this.config.passwordRef, { autoGenerate: false })
    return resolved.value
  }

  async rpc(params, signal) {
    const timeout = AbortSignal.timeout(this.config.timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    let response
    try {
      response = await fetch(`${this.url}/jsonrpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params, id: ++this.rpcId }),
        signal: combined,
        redirect: 'error',
      })
    } catch (error) {
      throw new Error(`Odoo request failed: ${errorMessage(error)}`)
    }
    const text = await response.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error(`Odoo returned non-JSON HTTP ${response.status}: ${truncate(text, 300)}`)
    }
    if (!response.ok) throw new Error(`Odoo HTTP ${response.status}: ${truncate(text, 300)}`)
    if (body?.error) {
      const detail = body.error.data?.message ?? body.error.message ?? 'unknown error'
      const name = body.error.data?.name ? `${body.error.data.name}: ` : ''
      throw new Error(`Odoo RPC error: ${truncate(`${name}${detail}`, 500)}`)
    }
    return body?.result
  }

  async login(signal) {
    const password = await this.password()
    const hash = sha256Hex(password)
    if (this.cache && this.cache.hash === hash && this.cache.expiresAt > Date.now()) return this.cache
    const uid = await this.rpc({ service: 'common', method: 'login', args: [this.config.db, this.config.username, password] }, signal)
    if (!uid || typeof uid !== 'number') throw new Error('Odoo login failed (check db/username/passwordRef)')
    this.cache = { uid, password, hash, expiresAt: Date.now() + 5 * 60 * 1000 }
    return this.cache
  }

  async executeKw(entity, method, args, kwargs = {}, signal) {
    const { model } = this.entityPolicy(entity)
    const { uid, password } = await this.login(signal)
    return this.rpc({
      service: 'object',
      method: 'execute_kw',
      args: [this.config.db, uid, password, model, method, args, kwargs],
    }, signal)
  }

  async query(entity, filter = {}, options = {}, signal) {
    const policy = this.entityPolicy(entity)
    const fields = options.fields?.length ? options.fields : policy.fields
    for (const field of fields) if (!policy.fields.includes(field)) throw new Error(`field "${field}" is not exposed for ${entity}`)
    const domain = []
    for (const [key, value] of Object.entries(filter)) {
      if (key === 'q' || key === 'limit' || key === 'offset') continue
      if (!policy.fields.includes(key)) throw new Error(`filter field "${key}" is not exposed for ${entity}`)
      domain.push([key, '=', value])
    }
    if (typeof filter.q === 'string' && filter.q && policy.fields.includes('name')) domain.push(['name', 'ilike', filter.q])
    const limit = Math.max(1, Math.min(Number(options.limit) || 20, 500))
    const offset = Math.max(0, Number(options.offset) || 0)
    const rows = await this.executeKw(entity, 'search_read', [domain], { fields, limit, offset, order: 'id desc' }, signal)
    const total = await this.executeKw(entity, 'search_count', [domain], {}, signal)
    return { entity, rows: rows ?? [], total: typeof total === 'number' ? total : rows?.length ?? 0, fields }
  }

  async get(entity, id, signal) {
    const policy = this.entityPolicy(entity)
    const numeric = Number(id)
    if (!Number.isInteger(numeric) || numeric <= 0) throw new Error(`Odoo ids are positive integers (got "${id}")`)
    const rows = await this.executeKw(entity, 'search_read', [[['id', '=', numeric]]], { fields: policy.fields, limit: 1 }, signal)
    return rows?.[0] ?? null
  }

  async createDraft(entity, data, signal) {
    const policy = this.entityPolicy(entity)
    if (!policy.writable) throw new Error(`${entity} is not writable in the odoo adapter; configure adapter.writable.${entity}`)
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('data must be an object')
    for (const key of Object.keys(data)) if (!policy.fields.includes(key)) throw new Error(`field "${key}" is not exposed for ${entity}`)
    const id = await this.executeKw(entity, 'create', [[data]], {}, signal)
    const doc = await this.executeKw(entity, 'read', [[id]], { fields: policy.fields }, signal)
    return { docId: String(id), doc: doc?.[0] ?? { id } }
  }

  async commit(entity, id, data = {}, signal) {
    const policy = this.entityPolicy(entity)
    if (!policy.writable) throw new Error(`${entity} is not writable in the odoo adapter`)
    const method = this.config.writable[entity]?.commitMethod
    if (!method) throw new Error(`adapter.writable.${entity}.commitMethod is required to commit ${entity}`)
    const numeric = Number(id)
    if (!Number.isInteger(numeric) || numeric <= 0) throw new Error(`Odoo ids are positive integers (got "${id}")`)
    const result = await this.executeKw(entity, method, [[numeric]], {}, signal)
    const doc = await this.executeKw(entity, 'read', [[numeric]], { fields: policy.fields }, signal)
    return { docId: String(id), state: doc?.[0]?.state ?? 'committed', result, doc: doc?.[0] }
  }

  async pollChanges() {
    return []
  }

  async health(signal) {
    const { uid } = await this.login(signal)
    return { ok: true, adapter: 'odoo', url: this.url, uid, models: this.entityNames() }
  }

  async buildResultWrite() {
    return null
  }
}
