import { errorMessage, oneLine, toJsonValue, truncate, withTimeout } from './util.js'
import { extractApprovals, extractToolCalls } from './sessions.js'

function textOutput(value) {
  const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text: truncate(body, 12000) }]
}

function outputDefinition() {
  return {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => textOutput(value),
  }
}

function entitySchema(adapter) {
  const names = adapter.entityNames?.() ?? []
  return {
    type: 'string',
    description: 'ERP entity name, for example purchase_order or sales_order.',
    ...(names.length > 0 ? { enum: names } : {}),
  }
}

function publicEntry(kind, entry) {
  if (kind === 'inbox') {
    return {
      kind,
      id: entry.id,
      state: entry.state,
      attempts: entry.attempts ?? 0,
      receivedAt: entry.receivedAt,
      nextAt: entry.nextAt,
      sessionId: entry.sessionId,
      source: entry.source,
      eventName: entry.eventName,
      entity: entry.payload?.entity,
      error: entry.error ?? entry.lastError,
    }
  }
  return {
    kind,
    id: entry.id,
    state: entry.state,
    attempts: entry.attempts ?? 0,
    createdAt: entry.createdAt,
    nextAt: entry.nextAt,
    target: entry.target,
    sessionId: entry.payload?.sessionId,
    turn: entry.payload?.turn,
    status: entry.payload?.status,
    error: entry.error ?? entry.lastError,
  }
}

async function requireApproval(ctx, exec, { toolName, reason, zh }) {
  const approval = ctx.get?.('approval')
  if (!approval) throw new Error('approval service is unavailable; write denied (fail closed)')
  if (!exec.agent) throw new Error('write tools require an initiating agent in an open turn')
  const outcome = await approval.request({
    agent: exec.agent,
    toolName,
    callId: exec.callId,
    reason,
    displayReason: { en: reason, zh },
    signal: exec.signal,
  })
  if (outcome !== 'allowed-once') throw new Error(`approval ${outcome}; nothing was written to ERP`)
}

/**
 * Register the model-facing tools. Read tools always exist; write tools are
 * absent from the registry unless policy.allowWrite is true. The bridge never
 * registers a write tool first and blocks it later.
 */
export function registerTools(deps) {
  const { ctx, config, adapter, inbox, outbox, tracker, secrets, ingress } = deps
  const disposers = []

  const assertWritable = (entity) => {
    const policy = adapter.entityPolicy(entity)
    if (!policy.writable) throw new Error(`${entity} is not writable in adapter "${adapter.id}"`)
    if (!config.policy.writableEntities.includes(entity)) {
      throw new Error(`${entity} is not in policy.writableEntities; write denied`)
    }
  }

  if (config.policy.tools.status) {
    disposers.push(ctx.tools.register({
      name: 'erp_status',
      description: 'Report ERP bridge health, adapter, ingress/outbound queues, ledger sizes, and write policy. Use before diagnosing a stalled integration.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: outputDefinition(),
      isConcurrencySafe: () => true,
      async execute() {
        let health
        try {
          health = await withTimeout(Promise.resolve().then(() => adapter.health?.()), 3000)
          if (health === undefined) health = { ok: false, error: 'adapter health timed out' }
        } catch (error) {
          health = { ok: false, error: errorMessage(error) }
        }
        let secret
        try {
          secret = await secrets.describe(config.ingress.signature.secretRef)
        } catch {
          secret = { configured: false }
        }
        return toJsonValue({
          bridge: 'dsh-erp-bridge',
          version: '0.1.0',
          adapter: adapter.id,
          adapterHealth: health,
          ingress: ingress.status(),
          inbound: inbox.status(),
          outbound: outbox.status(),
          policy: {
            allowWrite: config.policy.allowWrite,
            allowResend: config.policy.allowResend,
            writableEntities: config.policy.writableEntities,
          },
          secret,
          dataDir: config.dataDir,
          now: new Date().toISOString(),
        })
      },
    }))
  }

  if (config.policy.tools.query) {
    disposers.push(ctx.tools.register({
      name: 'erp_query',
      description: 'Query ERP records through the configured adapter. Read-only and bounded by the adapter field allow-list; returns at most policy.maxQueryRows rows.',
      parameters: {
        type: 'object',
        properties: {
          entity: entitySchema(adapter),
          filter: { type: 'object', additionalProperties: true, description: 'Equality filters by allowed field; q matches a substring across exposed fields.' },
          fields: { type: 'array', items: { type: 'string' }, description: 'Subset of exposed fields to return.' },
          limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Rows to return; bounded by policy.maxQueryRows.' },
          offset: { type: 'integer', minimum: 0 },
        },
        required: ['entity'],
        additionalProperties: false,
      },
      output: outputDefinition(),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const limit = Math.min(Number(args?.limit) || 20, config.policy.maxQueryRows)
        return toJsonValue(await adapter.query(String(args.entity), args.filter ?? {}, {
          fields: Array.isArray(args.fields) ? args.fields.map(String) : undefined,
          limit,
          offset: Math.max(0, Number(args.offset) || 0),
        }, exec.signal))
      },
    }))
  }

  if (config.policy.tools.get) {
    disposers.push(ctx.tools.register({
      name: 'erp_get',
      description: 'Fetch one ERP record by entity and id. Read-only and field-trimmed by the adapter allow-list.',
      parameters: {
        type: 'object',
        properties: {
          entity: entitySchema(adapter),
          id: { type: 'string', description: 'Vendor document id, for example PO-2026-0001.' },
        },
        required: ['entity', 'id'],
        additionalProperties: false,
      },
      output: outputDefinition(),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const doc = await adapter.get(String(args.entity), String(args.id), exec.signal)
        return toJsonValue({ entity: String(args.entity), id: String(args.id), doc })
      },
    }))
  }

  if (config.policy.tools.outbox) {
    disposers.push(ctx.tools.register({
      name: 'erp_ledger',
      description: 'List recent inbound and outbound delivery records with state, attempts, next retry, and error. Use it to explain a missing or failed ERP callback before retrying.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['outbox', 'inbox', 'all'], description: 'Which ledger to inspect; defaults to outbox.' },
          state: { type: 'string', description: 'Optional exact state filter, for example pending or failed.' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
        additionalProperties: false,
      },
      output: outputDefinition(),
      isConcurrencySafe: () => true,
      async execute(args) {
        const kind = args?.kind ?? 'outbox'
        const limit = Math.min(Number(args?.limit) || 20, 200)
        const state = typeof args?.state === 'string' ? args.state : undefined
        const rows = []
        if (kind === 'outbox' || kind === 'all') {
          for (const entry of outbox.ledger.list().sort((left, right) => right.createdAt - left.createdAt)) {
            if (state && entry.state !== state) continue
            rows.push(publicEntry('outbox', entry))
            if (rows.length >= limit) break
          }
        }
        if ((kind === 'inbox' || kind === 'all') && rows.length < limit) {
          for (const entry of inbox.ledger.list().sort((left, right) => right.receivedAt - left.receivedAt)) {
            if (state && entry.state !== state) continue
            rows.push(publicEntry('inbox', entry))
            if (rows.length >= limit) break
          }
        }
        return toJsonValue({
          kind,
          rows,
          outbox: outbox.status(),
          inbox: inbox.status(),
        })
      },
    }))
  }

  if (config.policy.tools.createDraft && config.policy.allowWrite) {
    disposers.push(ctx.tools.register({
      name: 'erp_create_draft',
      description: 'Create a DRAFT in the ERP. Write operation: the tool exists only when allowWrite is enabled, the entity is allow-listed, and the user must approve this exact call. A draft never commits or posts by itself.',
      parameters: {
        type: 'object',
        properties: {
          entity: entitySchema(adapter),
          data: { type: 'object', additionalProperties: true, description: 'Draft fields; restricted to the adapter field allow-list.' },
        },
        required: ['entity', 'data'],
        additionalProperties: false,
      },
      output: outputDefinition(),
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const entity = String(args.entity)
        assertWritable(entity)
        const reason = `Create ${entity} draft via dsh-erp-bridge: ${oneLine(JSON.stringify(args.data), 240)}`
        await requireApproval(ctx, exec, { toolName: 'erp_create_draft', reason, zh: `通过 DSH 在 ERP 创建 ${entity} 草稿` })
        return toJsonValue(await adapter.createDraft(entity, args.data, exec.signal))
      },
    }))
  }

  if (config.policy.tools.commit && config.policy.allowWrite) {
    disposers.push(ctx.tools.register({
      name: 'erp_commit',
      description: 'Commit or post one existing ERP document. Write operation: allow-listed entity, explicit user approval per call, and an adapter-configured commit method. Nothing is written when approval is rejected or unavailable.',
      parameters: {
        type: 'object',
        properties: {
          entity: entitySchema(adapter),
          id: { type: 'string', description: 'Document id to commit.' },
          note: { type: 'string', description: 'Optional audit note stored with the commit when the adapter supports it.' },
        },
        required: ['entity', 'id'],
        additionalProperties: false,
      },
      output: outputDefinition(),
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const entity = String(args.entity)
        const id = String(args.id)
        assertWritable(entity)
        const reason = `Commit ${entity} ${id} via dsh-erp-bridge${args.note ? `: ${oneLine(args.note, 160)}` : ''}`
        await requireApproval(ctx, exec, { toolName: 'erp_commit', reason, zh: `通过 DSH 提交/过账 ${entity} ${id}` })
        return toJsonValue(await adapter.commit(entity, id, { reason: args.note }, exec.signal))
      },
    }))
  }

  if (config.policy.tools.resend && config.policy.allowResend) {
    disposers.push(ctx.tools.register({
      name: 'erp_retry',
      description: 'Retry one failed inbound or outbound delivery after inspecting it with erp_ledger. Requires user approval because it re-sends enterprise data; successful retries are recorded in the ledger.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['outbox', 'inbox'] },
          id: { type: 'string', description: 'Exact ledger id.' },
        },
        required: ['kind', 'id'],
        additionalProperties: false,
      },
      output: outputDefinition(),
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const kind = String(args.kind)
        const id = String(args.id)
        await requireApproval(ctx, exec, {
          toolName: 'erp_retry',
          reason: `Retry ${kind} delivery ${id} to the ERP integration`,
          zh: `重试 ${kind} 投递 ${id}`,
        })
        const result = kind === 'inbox' ? await inbox.retry(id) : await outbox.resend(id)
        return toJsonValue(result)
      },
    }))
  }

  if (config.policy.tools.audit) {
    disposers.push(ctx.tools.register({
      name: 'erp_audit',
      description: 'Summarize this Session\'s ERP tool calls and approval decisions from the committed session log. Use it to answer who did what, with what arguments, and who approved it.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
        additionalProperties: false,
      },
      output: outputDefinition(),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        if (!exec.agent) throw new Error('erp_audit requires an initiating agent')
        let events = tracker.get(exec.agent.id)?.snapshotEvents()
        if (!events) {
          const sessionController = ctx.get?.('sessionController')
          if (!sessionController?.inspect) throw new Error('session log is unavailable for this Session')
          const inspection = await sessionController.inspect(exec.agent.id)
          events = inspection.events
        }
        const limit = Math.min(Number(args?.limit) || 50, 200)
        const toolCalls = extractToolCalls(events)
          .filter((call) => call.name?.startsWith('erp_'))
          .slice(-limit)
        const allApprovals = extractApprovals(events)
        const erpApprovalIds = new Set(allApprovals
          .filter((approval) => approval.type === 'approval/asked' && typeof approval.data?.toolName === 'string' && approval.data.toolName.startsWith('erp_'))
          .map((approval) => approval.data.id))
        const approvals = allApprovals
          .filter((approval) => approval.type === 'approval/policy'
            || (approval.type === 'approval/asked' && erpApprovalIds.has(approval.data?.id))
            || (approval.type === 'approval/decided' && erpApprovalIds.has(approval.data?.id)))
          .slice(-limit)
        return toJsonValue({
          sessionId: exec.agent.id,
          inbound: tracker.inboundFor(exec.agent.id) ?? null,
          toolCalls,
          approvals,
          note: 'Derived from the committed session log; the ledger only tracks delivery state.',
        })
      },
    }))
  }

  return disposers
}
