#!/usr/bin/env node
/** Emit one realistic signed ERP event through the mock's /mock/emit proxy. */
const deliveryId = process.argv[2] ?? `PO-2026-0002:submitted:${Date.now()}`
const eventName = process.argv[3] ?? 'purchase_order.submitted'
const body = {
  source: 'kingdee-cloud',
  deliveryId,
  eventName,
  occurredAt: Date.now(),
  entity: { type: 'purchase_order', id: 'PO-2026-0002' },
  data: {
    amount: 46800.5,
    currency: 'CNY',
    vendor: 'V-002',
    submittedBy: '李娜',
    note: '供应商交期可能延误，请评估是否需要拆分订单。',
  },
}
const response = await fetch('http://127.0.0.1:3082/mock/emit', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
console.log(response.status, await response.text())
