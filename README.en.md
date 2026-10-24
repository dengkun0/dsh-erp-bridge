# dsh-erp-bridge

A two-way enterprise-system integration plugin for DeepSeek Harness (DSH). It is a reusable integration engine, not another vendor-specific tool pack.

```
ERP ──signed event──▶ ingress ──▶ inbox ledger ──▶ read-only Session ──▶ ERP tools
                                                                      │
ERP ◀──signed callback── outbox ◀── turn/end projection ◀─────────────┘
```

- **Inbound**: HMAC-signed ERP events are persisted, deduplicated, then open a **read-only** DSH Session with the event marked as untrusted data.
- **Outbound**: `turn/end` is projected into a signed, idempotent callback; 5xx/408/429 retry with exponential backoff, 4xx fail permanently, and pending work survives a restart.
- **Adapters**: `mock`, `odoo` (JSON-RPC), and `http-gateway` (the thin middleware contract for legacy ERPs such as Yonyou U8/NC, Kingdee K3, SAP ECC).
- **Write-back**: `erp_create_draft` / `erp_commit` are not registered at all unless `allowWrite` is true and the entity is allow-listed. Every write call requires `ctx.approval`; unavailable approval means denial.
- **Audit**: `erp_audit` folds the committed Session log (tool calls + approval pairs); the ledger only tracks delivery state.

Validated on DSH Desktop `0.2.1-rc.3` with two live end-to-end deliveries. See [the implementation plan](docs/implementation-plan.md).

---

## Install

Requirements: DSH Host/Desktop `0.2.1-rc.3`, Node `^22.19 || >=24`. No npm dependencies.

```text
plugin_manager install_bundle  target: <absolute-path>/dsh-erp-bridge
```

After installation:

- tools `erp_status`, `erp_query`, `erp_get`, `erp_ledger`, `erp_audit` are registered; write tools appear only with `allowWrite`;
- ingress listens on `127.0.0.1:3081` (`POST /erp/events`, `GET /erp/health`);
- data lives under `dataDir` (default `<DSH_PROFILE_DIR>/erp-bridge`).

Local directory installs are linked. After editing code, disable and enable the row (`include:dsh-erp-bridge`) to reload the ESM module.

Uninstall: `plugin_manager remove_bundle target: dsh-erp-bridge`. The ledger stays on disk.

---

## Quick demo

```powershell
# terminal 1: mock ERP receiver
node mock-erp/server.mjs --port 3082 --data-dir "C:\Users\<you>\.dsh\profiles\desktop\.dsh-erp-bridge"

# terminal 2: emit a signed event
node test/emit-live.mjs "PO-2026-0002:submitted:v1" "purchase_order.submitted"
```

Then inspect:

```text
erp_status
erp_ledger kind=all
erp_audit
```

and `GET http://127.0.0.1:3082/mock/state` to see the signed result callback.

---

## Configuration (summary)

```yaml
- id: dsh-erp-bridge
  name: dsh-erp-bridge
  config:
    dataDir: 'D:\dsh-data\erp-bridge'
    adapter:
      id: http-gateway
      baseUrl: 'http://erp-gateway.internal:8080'
      authRef: ERP_GATEWAY_TOKEN
      entities:
        purchase_order:
          fields: [id, number, vendor, amount, currency, status]
          writable: true
    ingress:
      enabled: true
      mode: standalone
      host: 127.0.0.1
      port: 3081
      path: /erp/events
      signature:
        secretRef: DSH_ERP_HMAC_SECRET
        autoGenerate: false
    outbound:
      enabled: true
      targetUrl: 'http://erp-gateway.internal:8080/dsh/turn-result'
      scope: linked
    inbound:
      enabled: true
      agentPreset: standard
      permissionPreset: read-only
    policy:
      allowWrite: false
      writableEntities: [purchase_order]
```

| Field | Default | Notes |
|---|---|---|
| `dataDir` | `<DSH_PROFILE_DIR>/erp-bridge` | ledgers, secret, inbound workspace; single-instance only |
| `adapter.id` | `mock` | `mock` / `odoo` / `http-gateway` |
| `ingress.mode` | `standalone` | separate loopback listener; `embedded` only for demos |
| `outbound.scope` | `linked` | `linked` / `erp-tools` / `all` |
| `inbound.permissionPreset` | `read-only` | verified against the live projection |
| `inbound.workspacePath` | `<dataDir>/workspace` | isolated from the profile |
| `policy.allowWrite` | `false` | write tools are absent unless true |

Full reference: `lib/config.js`.

---

## Tools

| Tool | Approval | Purpose |
|---|---|---|
| `erp_status` | — | adapter health, queues, policy, secret source |
| `erp_query` | — | bounded, field-allow-listed query |
| `erp_get` | — | one record |
| `erp_ledger` | — | inbox/outbox states, attempts, errors |
| `erp_audit` | — | Session-log tool/approval evidence |
| `erp_create_draft` | every call | draft only; not registered without `allowWrite` |
| `erp_commit` | every call | adapter-configured commit method |
| `erp_retry` | every call | re-deliver a failed inbox/outbox entry |

---

## Security

1. HMAC-SHA256 over `${timestamp}.${rawBody}`, ±5 minute window, constant-time compare.
2. `(source, deliveryId)` idempotency; same id with a different body returns 409.
3. Persist before 202; the pump creates the Session asynchronously.
4. Inbound Sessions are switched to `read-only` and the projection is verified; no fallback to workspace-write.
5. Prompt injection surface is explicit: the ERP JSON is labeled untrusted, and inbound Sessions have no write tools.
6. Write tools are not registered unless three allow-lists agree; every call asks `ctx.approval` and fails closed.
7. Secrets resolve through the DSH credential seam, then env, then a 0600 file; values never appear in logs or status.
8. SSRF baseline: http(s) only, no URL credentials, cloud-metadata hosts always rejected; private networks are configurable.
9. Data minimization: `scope=linked`, summary can be disabled, tool arguments are excluded by default.

**Important**: DSH Host plugins run in-process without a sandbox. Installing a plugin means trusting its code. For enterprise review, provide the source, the zero-dependency manifest, default read-only behavior, and the write-approval chain.

See [security checklist](docs/security-checklist.md).

---

## Tests

```powershell
node test/unit.test.mjs   # 12 checks: ledger, config, HMAC, ingress, mock adapter
node test/e2e.mjs         # 7 checks: outbox retry/signature, scopes, write approval, inbound pump
```

Live acceptance results (two signed events, two Sessions, two callbacks, read-only projection, workspace isolation, rejected write) are in [the implementation plan](docs/implementation-plan.md#12-验收记录).

---

## Layout

```
index.js                 Host plugin entry
lib/bridge.js            lifecycle
lib/ingress.js           HMAC inbound listener
lib/inbox.js             inbound pump (Session + read-only + prompt + retry)
lib/outbox.js            turn/end projection + signed delivery
lib/ledger.js            append-only JSONL ledgers and folds
lib/adapters/            mock / odoo / http-gateway
lib/tools.js             model-facing tools
mock-erp/server.mjs      demo receiver and event proxy
test/                    unit, e2e, live emitter
docs/                    implementation plan, adapter contract, security checklist
```

License: MIT. Demo data is fictional.
