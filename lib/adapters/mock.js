const DEMO_ENTITIES = {
  purchase_order: {
    fields: ['id', 'number', 'vendor', 'vendorName', 'amount', 'currency', 'status', 'createdAt', 'updatedAt'],
    writable: true,
  },
  sales_order: {
    fields: ['id', 'number', 'customer', 'amount', 'currency', 'status', 'createdAt', 'updatedAt'],
    writable: false,
  },
  vendor: {
    fields: ['id', 'name', 'taxId', 'country', 'status'],
    writable: false,
  },
  invoice: {
    fields: ['id', 'number', 'orderId', 'amount', 'currency', 'status', 'issuedAt'],
    writable: false,
  },
}

function seedDocs() {
  const now = Date.now()
  return [
    {
      entity: 'purchase_order',
      doc: {
        id: 'PO-2026-0001',
        number: 'PO-2026-0001',
        vendor: 'V-001',
        vendorName: '华东精密制造有限公司',
        amount: 128000,
        currency: 'CNY',
        status: 'approved',
        createdAt: now - 86400000 * 12,
        updatedAt: now - 86400000 * 2,
      },
    },
    {
      entity: 'purchase_order',
      doc: {
        id: 'PO-2026-0002',
        number: 'PO-2026-0002',
        vendor: 'V-002',
        vendorName: '南方电子元件厂',
        amount: 46800.5,
        currency: 'CNY',
        status: 'pending',
        createdAt: now - 86400000 * 5,
        updatedAt: now - 3600000,
      },
    },
    {
      entity: 'sales_order',
      doc: {
        id: 'SO-2026-0101',
        number: 'SO-2026-0101',
        customer: 'C-009',
        amount: 320000,
        currency: 'CNY',
        status: 'confirmed',
        createdAt: now - 86400000 * 3,
        updatedAt: now - 86400000,
      },
    },
    {
      entity: 'vendor',
      doc: { id: 'V-001', name: '华东精密制造有限公司', taxId: '91310000DEMO0001X', country: 'CN', status: 'active' },
    },
    {
      entity: 'vendor',
      doc: { id: 'V-002', name: '南方电子元件厂', taxId: '91440100DEMO0002Y', country: 'CN', status: 'active' },
    },
    {
      entity: 'invoice',
      doc: {
        id: 'INV-2026-0007',
        number: 'INV-2026-0007',
        orderId: 'PO-2026-0001',
        amount: 128000,
        currency: 'CNY',
        status: 'issued',
        issuedAt: now - 86400000,
      },
    },
  ]
}

function project(doc, fields) {
  const output = {}
  for (const field of fields) if (doc[field] !== undefined) output[field] = doc[field]
  return output
}

/**
 * In-memory demo ERP used by the shipped patch and by contract tests. It never
 * touches the network and is deliberately small: query, get, draft, commit.
 */
export class MockAdapter {
  constructor() {
    this.id = 'mock'
    this.demo = true
    this.entities = DEMO_ENTITIES
    this.docs = new Map()
    this.changes = []
    this.counter = 0
    for (const { entity, doc } of seedDocs()) {
      if (!this.docs.has(entity)) this.docs.set(entity, new Map())
      this.docs.get(entity).set(doc.id, { ...doc })
      this.changes.push({ at: doc.updatedAt ?? doc.createdAt ?? Date.now(), entity, id: doc.id, operation: 'seed' })
    }
  }

  entityNames() {
    return Object.keys(this.entities)
  }

  entityPolicy(entity) {
    const policy = this.entities[entity]
    if (!policy) throw new Error(`unknown entity "${entity}"; available: ${this.entityNames().join(', ')}`)
    return policy
  }

  async query(entity, filter = {}, options = {}) {
    const policy = this.entityPolicy(entity)
    const fields = options.fields?.length ? options.fields : policy.fields
    for (const field of fields) if (!policy.fields.includes(field)) throw new Error(`field "${field}" is not exposed for ${entity}`)
    const docs = [...(this.docs.get(entity)?.values() ?? [])]
    const query = typeof filter.q === 'string' ? filter.q.toLowerCase() : ''
    const predicates = Object.entries(filter).filter(([key]) => key !== 'q' && key !== 'limit' && key !== 'offset')
    for (const [key] of predicates) {
      if (!policy.fields.includes(key)) throw new Error(`filter field "${key}" is not exposed for ${entity}`)
    }
    const matched = docs.filter((doc) => {
      if (query && !policy.fields.some((field) => String(doc[field] ?? '').toLowerCase().includes(query))) return false
      return predicates.every(([key, value]) => String(doc[key]) === String(value))
    }).sort((left, right) => (right.updatedAt ?? right.createdAt ?? 0) - (left.updatedAt ?? left.createdAt ?? 0))
    const offset = Math.max(0, Number(options.offset) || 0)
    const limit = Math.max(1, Math.min(Number(options.limit) || 20, 500))
    return {
      entity,
      rows: matched.slice(offset, offset + limit).map((doc) => project(doc, fields)),
      total: matched.length,
      fields,
      demo: true,
    }
  }

  async get(entity, id) {
    const policy = this.entityPolicy(entity)
    const doc = this.docs.get(entity)?.get(String(id))
    if (!doc) return null
    return project(doc, policy.fields)
  }

  async createDraft(entity, data) {
    const policy = this.entityPolicy(entity)
    if (!policy.writable) throw new Error(`${entity} is read-only in the mock adapter`)
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('data must be an object')
    for (const key of Object.keys(data)) if (!policy.fields.includes(key)) throw new Error(`field "${key}" is not exposed for ${entity}`)
    this.counter += 1
    const id = `DRAFT-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${String(this.counter).padStart(4, '0')}`
    const now = Date.now()
    const doc = {
      ...data,
      id,
      number: data.number ?? id,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      demo: true,
    }
    if (!this.docs.has(entity)) this.docs.set(entity, new Map())
    this.docs.get(entity).set(id, doc)
    this.changes.push({ at: now, entity, id, operation: 'create-draft' })
    return { docId: id, doc: project(doc, policy.fields) }
  }

  async commit(entity, id, data = {}) {
    const policy = this.entityPolicy(entity)
    if (!policy.writable) throw new Error(`${entity} is read-only in the mock adapter`)
    const doc = this.docs.get(entity)?.get(String(id))
    if (!doc) throw new Error(`${entity} ${id} was not found`)
    const now = Date.now()
    doc.status = 'approved'
    doc.updatedAt = now
    doc.approvedAt = now
    if (data.reason) doc.approvalNote = String(data.reason).slice(0, 500)
    this.changes.push({ at: now, entity, id, operation: 'commit' })
    return { docId: id, state: doc.status, doc: project(doc, policy.fields) }
  }

  async pollChanges(since = 0) {
    return this.changes.filter((change) => change.at > since)
  }

  async health() {
    return { ok: true, adapter: 'mock', demo: true, documents: [...this.docs.values()].reduce((sum, map) => sum + map.size, 0) }
  }

  async buildResultWrite() {
    return null
  }
}
