# 验收证据

> 环境：DSH Desktop / Host `0.2.1-rc.3`，Windows，profile `desktop`，mock 适配器，mock ERP 接收器 `127.0.0.1:3082`。
> 时间：2026-10-24（Asia/Shanghai）。以下数据直接从本机 profile 与台账读取，不是复述。

---

## 1. 安装状态

```text
plugin_manager install_bundle target: G:\deepseek\dsh-erp-bridge
→ stage: enable, application: applied, warnings: []

plugin_manager list_bundles
→ name: dsh-erp-bridge
  version: 0.1.0
  source: link:G:\deepseek\dsh-erp-bridge
  enabled: true
  installed: true
  row: dsh-erp-bridge → include:dsh-erp-bridge
```

`include:dsh-erp-bridge` 在 `list_plugins` 中为 `enabled: true`、`fiberPhase: active`。

工具目录（`Tool.listTools`）包含：

```text
erp_status  erp_query  erp_get  erp_ledger
erp_create_draft  erp_commit  erp_retry  erp_audit
```

健康检查：

```http
GET http://127.0.0.1:3081/erp/health
→ 200 {"ok":true,"service":"dsh-erp-bridge","adapter":"mock",
        "ingress":{"mode":"standalone","path":"/erp/events"},
        "inbox":{"entries":2,"states":{"prompted":2},"corrupt":0}}
```

---

## 2. `erp_status`（最终运行态）

```json
{
  "bridge": "dsh-erp-bridge",
  "version": "0.1.0",
  "adapter": "mock",
  "adapterHealth": { "ok": true, "adapter": "mock", "demo": true, "documents": 6 },
  "ingress": { "mode": "standalone", "url": "http://127.0.0.1:3081/erp/events", "port": 3081 },
  "inbound": { "enabled": true, "entries": 2, "states": { "prompted": 2 }, "nextAt": null },
  "outbound": {
    "enabled": true,
    "target": "http://127.0.0.1:3082/api/dsh/turn-result",
    "scope": "linked",
    "delivered": 2,
    "failed": 0,
    "entries": 2,
    "states": { "done": 2 },
    "pending": 0
  },
  "policy": { "allowWrite": true, "allowResend": true, "writableEntities": ["purchase_order"] },
  "secret": {
    "configured": true,
    "source": "file:C:\\Users\\<user>\\.dsh\\profiles\\desktop\\.dsh-erp-bridge\\secret"
  },
  "dataDir": "C:\\Users\\<user>\\.dsh\\profiles\\desktop/.dsh-erp-bridge"
}
```

---

## 3. 入站台账事实（`inbox.jsonl`）

| t | deliveryId | sessionId | attempts | error |
|---|---|---|---|---|
| `in` | `PO-2026-0001:approved:v1` | — | — | — |
| `sid` | 同上 | `c23999e9-4a83-46ed-ae73-50398b2558e2` | — | — |
| `attempt` | 同上 | — | 1 | `Cannot read properties of undefined (reading 'throwIfAborted')` |
| `attempt` | 同上 | — | 2 | 同上 |
| `attempt` | 同上 | — | 3 | 同上 |
| `prompted` | 同上 | `c23999e9-…` | — | — |
| `in` | `PO-2026-0002:submitted:v1` | — | — | — |
| `sid` | 同上 | `8ee27afb-ab49-4c93-931b-ff42029179ff` | — | — |
| `prompted` | 同上 | `8ee27afb-…` | — | — |

说明：

- 第一条在开发期暴露了 `sessionController.prompt` 必须传 `AbortSignal` 的缺陷；台账自动重试 3 次，修复后第 4 次成功。**这恰好验证了"先落盘 + 重试泵"在真实缺陷下的恢复能力。**
- 第二条一次通过：`in → sid → prompted`，无 attempt。
- 最终折叠状态：`prompted: 2`，无 `failed`。

---

## 4. 出站台账事实（`outbox.jsonl`）

| t | id | status | attempts |
|---|---|---|---|
| `put` | `c23999e9-4a83-46ed-ae73-50398b2558e2:1` | — | — |
| `done` | 同上 | 200 | — |
| `put` | `8ee27afb-ab49-4c93-931b-ff42029179ff:1` | — | — |
| `done` | 同上 | 200 | — |

最终折叠：`done: 2`、`failed: 0`、`pending: 0`。

---

## 5. Session 权限与工作区（projection cache）

### 5.1 第一条（`c23999e9-…`）

```json
"permissions": { "preset": "read-only", "sandbox": "read-only", "approval": "ask", "seeded": false }
"workingDirectory": "C:\\Users\\<user>\\.dsh\\profiles\\desktop"
```

> 这条在"入站工作区隔离"改动之前创建，所以 cwd 仍是 profile 目录；权限只读已生效。

### 5.2 第二条（`8ee27afb-…`，最终配置）

```json
"permissions": { "preset": "read-only", "sandbox": "read-only", "approval": "ask", "seeded": false }
"workingDirectory": "C:\\Users\\<user>\\.dsh\\profiles\\desktop\\.dsh-erp-bridge\\workspace"
```

**只读 + 工作区隔离**均已在最终配置下验证。

---

## 6. ERP 回调接收（`mock-erp-received.jsonl`）

mock ERP 按 `Idempotency-Key` 去重后落库两条：

| key | payload.status | payload.turn | payload.erp.deliveryId |
|---|---|---|---|
| `c23999e9-…:1` | `completed` | 1 | `PO-2026-0001:approved:v1` |
| `8ee27afb-…:1` | `completed` | 1 | `PO-2026-0002:submitted:v1` |

第二条 payload 中包含完整中文分析（`## PO-2026-0002 提交事件 · 拆单评估（只读）…`），证明 UTF-8 事件与回调链路正常。

`GET http://127.0.0.1:3082/mock/state` 同时显示：

```json
"received": 2,
"emitted": [
  { "deliveryId": "PO-2026-0001:approved:v1", "status": 202 },
  { "deliveryId": "PO-2026-0002:submitted:v1", "status": 202 },
  { "deliveryId": "PO-2026-0002:submitted:v1", "status": 409 }
]
```

最后一条是同 `deliveryId`、不同 body 的重放，被 ingress 以 **409 `delivery-id-conflict`** 拒绝。

---

## 7. 写回审批证据（`erp_audit`）

在当前 Session（审批策略被切换为 `never`）调用 `erp_create_draft`：

```json
{
  "name": "erp_create_draft",
  "ok": false,
  "error": "Error: approval rejected; nothing was written to ERP"
}
```

审批事件成对出现：

```json
{
  "type": "approval/asked",
  "data": {
    "id": "7e65a22d-992e-4c9c-ae24-47106d189e30",
    "toolName": "erp_create_draft",
    "reason": "Create purchase_order draft via dsh-erp-bridge: {\"vendor\":\"V-001\",\"amount\":1000,\"currency\":\"CNY\"}"
  }
}
{
  "type": "approval/decided",
  "data": { "id": "7e65a22d-992e-4c9c-ae24-47106d189e30", "outcome": "rejected" }
}
```

mock 适配器文档数保持 `6`，没有新增草稿；审批拒绝时 ERP 无任何变更。

---

## 8. 自动化测试

```text
node test/unit.test.mjs  → 12/12 pass
node test/e2e.mjs        → 7/7 pass
```

覆盖：

- 台账折叠、JSONL 重开、最后半行损坏；
- 配置默认值/校验、prompt 模板、envelope 校验；
- HMAC、时间窗、防重放、同 id 不同 body 409、空白差异 duplicate；
- mock 适配器字段/写实体白名单；
- outbox 签名、幂等、503 重试、400 永久失败；
- `linked` scope 不误投未关联会话；
- 写工具注册条件、`allowed-once` / `rejected` 审批；
- 入站泵 `read-only` + prompt marker + 入站链接。

---

## 9. 复现命令

```powershell
# 启动 mock ERP（验收后已停止）
node mock-erp/server.mjs --port 3082 --data-dir "C:\Users\<user>\.dsh\profiles\desktop\.dsh-erp-bridge"

# 发一条签名事件（UTF-8）
node test/emit-live.mjs "PO-2026-0002:submitted:v1" "purchase_order.submitted"

# 在 DSH 中查看
erp_status
erp_ledger kind=all
erp_audit

# 自动化测试
node test/unit.test.mjs
node test/e2e.mjs
```

---

## 10. 未覆盖/未验证

| 项 | 状态 |
|---|---|
| 真实 Odoo 实例 | 未活体验证；代码按公开 JSON-RPC 协议实现 |
| 真实用友/金蝶/SAP 网关 | 未活体验证；契约见 `docs/adapter-contract.md` |
| 多实例 SQLite/Postgres | 未实现（P4） |
| 台账侧边栏 UI | 未实现（P3） |
| ERP 侧回调验签实现 | mock 已实现；客户网关需按契约自行实现 |
| 页面视觉/插件图标渲染 | 无法在没有浏览器控制的情况下验证；locale/icon 文件已校验存在且可解析 |

---

## 11. 补充：演示运行 v2（2026-10-24 20:57）

为验证"重复演示不冲突"，使用新的 `deliveryId` 再跑一遍完整链路：

```text
deliveryId: PO-2026-0002:submitted:v2
eventName:  purchase_order.submitted
```

| 检查 | 结果 |
|---|---|
| mock ERP 启动 | `127.0.0.1:3082` |
| ingress 响应 | `202 {"status":"accepted"}` |
| inbox | `prompted`，无 attempt |
| Session | `79abc38f-2f35-40c1-af86-37f964c8da79` |
| 权限投影 | `preset=read-only`、`sandbox=read-only`、`approval=ask` |
| 工作区 | `C:\Users\<user>\.dsh\profiles\desktop\.dsh-erp-bridge\workspace` |
| Agent 工具 | `erp_get` ×2、`erp_query` ×3、`erp_ledger`、`erp_status` |
| 回合 | 1 turn / 5 steps，正常结束 |
| outbox | `79abc38f-…:1 done`（HTTP 200） |
| mock ERP | 收到 `79abc38f-…:1`，`payload.erp.deliveryId = PO-2026-0002:submitted:v2` |
| 汇总 | inbox 3 prompted / 0 failed；outbox 3 done / 0 failed |

本次演示的结论摘要：

> 建议暂不拆单。先向供应商要求按行、按交期提供书面承诺，优先采用"同一张 PO 内分批交货"；只有当订单可按独立需求日期清晰切分，且拆分后每一份仍满足 MOQ/价格阶梯时，才把拆单写进流程。

这次运行证明：换一个新的 `deliveryId` 可以重复演示，不会与之前的 v1 事件冲突；同一个 mock ERP 也能按 `Idempotency-Key` 正确接收多条不同的回调。

