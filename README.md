# dsh-erp-bridge

把 DeepSeek Harness（DSH）接进企业既有系统（ERP / MES / OA / 财务）的**双向集成插件**。

它不是一个"把某家 ERP 的 API 包成一组工具"的工具集，而是一层可复用的集成引擎：

```
ERP ──签名事件──▶ 入站监听器 ──▶ inbox 台账 ──▶ 只读 Session ──▶ ERP 工具
                                                              │
ERP ◀──签名回调── 投递器 ◀── outbox 台账 ◀── turn/end 投影 ◀──┘
```

- **入站**：ERP 的审批完成、单据变更、异常预警以 HMAC 签名的 HTTP 事件进入；先落盘、去重、再创建 **read-only** Session，把事件作为明确标记的"不可信数据"交给 Agent。
- **出站**：Session 的 `turn/end` 被投影成结果回调，带幂等键与 HMAC 签名投递回 ERP；失败按 5xx/408/429 指数退避，4xx 立即判永久失败，进程重启后继续投递。
- **适配器**：`mock`（开箱即用）、`odoo`（JSON-RPC）、`http-gateway`（给用友 U8/NC、金蝶 K3、SAP ECC 这类传统 ERP 的中间件契约）。厂商差异被收在一个接口后面。
- **写回**：`erp_create_draft` / `erp_commit` 默认**不注册**；只有 `policy.allowWrite: true` 且实体在 `policy.writableEntities` 中才存在，并且每次调用都要过 DSH 的 `ctx.approval`。审批不可用 = 拒绝，不是放行。
- **审计**：不建第二套真相。`erp_audit` 从 Session 日志折叠出"谁、调了什么工具、参数、结果、谁批准/拒绝"，台账只负责投递状态。

> 已在 DSH Desktop **0.2.1-rc.3** 上安装并完成两条真实端到端链路：ERP 事件 → 只读 Session → Agent 调 `erp_*` 工具 → `turn/end` → 签名投递 → mock ERP 收到。详见 [实现方案](docs/implementation-plan.md) 与 [验收证据](docs/acceptance-evidence.md)。

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [安装](#安装)
- [5 分钟演示](#5-分钟演示)
- [配置](#配置)
- [工具](#工具)
- [适配器](#适配器)
- [安全边界](#安全边界)
- [生产部署清单](#生产部署清单)
- [运维](#运维)
- [测试](#测试)
- [目录结构](#目录结构)

---

## 它解决什么问题

企业里真正难的不是"让模型查一张单据"，而是下面四件事：

| 问题 | 常见做法 | 本插件的做法 |
|---|---|---|
| ERP 变了，Agent 怎么被叫醒？ | 人手动发起对话 | 签名事件 + 独立监听器 + 去重台账 + 自动创建只读 Session |
| Agent 做完，ERP 怎么知道？ | 无，或进程内 fire-and-forget | `turn/end` 投影 + 持久 outbox + 重试/退避/幂等键/签名 |
| 进程崩了会不会丢事件？ | 会 | 先落盘再 202；重启后 inbox/outbox 继续推进 |
| Agent 会不会乱写 ERP？ | `allowWrite` 开关一开了之 | 写工具默认不存在 + 实体白名单 + 每次人工审批 + 只读 Session 默认值 |

**非目标**：不替代 ERP 自己的审批流；不做浏览器自动化；不把 ERP 全量数据同步进 DSH；不在插件里保存 ERP 密码明文。

---

## 安装

### 前置

- DSH Desktop / Host `0.2.1-rc.3`（`@deepseek-ai/dsh-base` 版本）
- Node `^22.19 || >=24`
- 不需要任何 npm 依赖：插件只使用 Node 内置模块

### 安装到当前 profile

在 DSH 会话里让 Agent 执行（或从终端调用 `dsh` 的插件管理）：

```text
plugin_manager install_bundle  target: <绝对路径>/dsh-erp-bridge
```

安装器会把它链入 profile、追加 bundle，并通过 HMR 激活。安装后：

1. `erp_status`、`erp_query`、`erp_get`、`erp_ledger`、`erp_audit` 等工具出现在工具列表；
2. 入站监听器默认在 `127.0.0.1:3081` 提供 `POST /erp/events`；
3. 健康检查：`GET http://127.0.0.1:3081/erp/health`；
4. 数据目录默认 `<DSH_PROFILE_DIR>/erp-bridge`；本仓库附带的 `cordis.patch.yml` 为演示把它放在 `<profile>/.dsh-erp-bridge`。

> 本包是**本地目录安装**。修改代码后需要让 Loader 重新加载模块：在插件管理里禁用再启用该行（`include:dsh-erp-bridge`）即可；仅改文件不会自动重载 ESM 模块。

### 卸载 / 回滚

```text
plugin_manager remove_bundle  target: dsh-erp-bridge
```

台账留在 `dataDir` 不删除；重装后继续投递。删除 `dataDir` 才会清空幂等与重试历史。

---

## 5 分钟演示

演示使用仓库自带的 mock ERP 接收器，不需要真实 ERP。

**1. 启动 mock ERP**（另开一个终端；`--data-dir` 要和插件配置一致）

```powershell
node mock-erp/server.mjs --port 3082 --data-dir "C:\Users\<你>\.dsh\profiles\desktop\.dsh-erp-bridge"
```

**2. 发一条签名 ERP 事件**

```powershell
node test/emit-live.mjs "PO-2026-0002:submitted:v1" "purchase_order.submitted"
```

mock 会用 `dataDir/secret` 里的密钥签名，转发到 `127.0.0.1:3081/erp/events`。事件进入后：

- `erp_ledger kind=inbox` 看到 `received → prompted`；
- Session 列表出现标题类似 `Purchase order ERP approval event` 的会话；
- 该 Session 是 `read-only`，工作目录是 `dataDir/workspace`（与 profile 隔离）；
- Agent 调用 `erp_query` / `erp_get` / `erp_ledger` 分析事件；
- 回合结束，`erp_ledger kind=outbox` 出现 `done`；
- `GET http://127.0.0.1:3082/mock/state` 能看到收到的结果回调。

**3. 看完整证据链**

```text
erp_status
erp_ledger kind=all
erp_audit
```

`erp_audit` 从 Session 日志折叠出本次会话的 ERP 工具调用与审批记录；`erp_ledger` 只显示投递状态。

**4. 试写回**

把当前 Session 的权限切到 `workspace-write`（审批策略 `ask`），然后让 Agent：

> 在 ERP 创建一张采购订单草稿：供应商 V-001，金额 1000 CNY，然后提交。

`erp_create_draft` 会先弹出审批；拒绝时 ERP 无任何变化。`erp_commit` 是第二次独立审批。

> 在 `danger-full-access`（审批策略 `never`）下，DSH 的审批服务会直接拒绝写工具：这是有意的 fail-closed 行为，不是插件故障。

---

## 配置

配置写在 profile 的 `cordis.patch.yml`（或 bundle 自带 patch）中，整段替换，不深合并：

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
          fields: [id, number, vendor, vendorName, amount, currency, status]
          writable: true
        vendor:
          fields: [id, name, taxId, status]
          writable: false

    ingress:
      enabled: true
      mode: standalone       # standalone | embedded
      host: 127.0.0.1
      port: 3081
      path: /erp/events
      signature:
        secretRef: DSH_ERP_HMAC_SECRET
        timestampWindowSec: 300
        autoGenerate: false   # 生产建议 false，密钥走凭据 seam

    outbound:
      enabled: true
      targetUrl: 'http://erp-gateway.internal:8080/dsh/turn-result'
      scope: linked           # linked | erp-tools | all
      includeSummary: true
      summaryMaxChars: 2000
      maxAttempts: 8
      baseDelayMs: 2000
      maxDelayMs: 300000
      timeoutMs: 10000

    inbound:
      enabled: true
      agentPreset: standard
      permissionPreset: read-only
      eventNames: []           # 空 = 全部；可填 [purchase_order.approved]
      maxAttempts: 10

    policy:
      allowWrite: false
      allowResend: true
      writableEntities: [purchase_order]
      maxQueryRows: 50
```

### 字段说明（摘要）

| 字段 | 默认 | 说明 |
|---|---|---|
| `dataDir` | `<DSH_PROFILE_DIR>/erp-bridge` | 台账、密钥、演示工作区的根目录；需单实例独占 |
| `adapter.id` | `mock` | `mock` / `odoo` / `http-gateway` |
| `ingress.mode` | `standalone` | `standalone` 独立 loopback 监听；`embedded` 挂到现有 DSH webServer（仅演示） |
| `ingress.host/port` | `127.0.0.1:3081` | 只绑回环；外层反代终结 TLS |
| `ingress.signature.secretRef` | `DSH_ERP_HMAC_SECRET` | 先查 DSH 凭据 seam，再查环境变量，最后查 `dataDir/secret` |
| `ingress.signature.autoGenerate` | `true` | 首次无密钥时生成 32 字节随机值写入 0600 文件 |
| `outbound.scope` | `linked` | `linked` 只回写由 ERP 事件打开的会话；`erp-tools` 还包含用过 `erp_*` 工具的会话；`all` 全部 |
| `outbound.includeSummary` | `true` | 是否把回合最终答复摘要发给 ERP；敏感场景设 `false` |
| `inbound.permissionPreset` | `read-only` | 入站会话强制切换到的权限预设；不可用则拒绝创建 |
| `inbound.workspacePath` | `<dataDir>/workspace` | 入站会话工作区，默认与 profile 隔离 |
| `policy.allowWrite` | `false` | 为 `true` 才注册写工具；仍逐次审批 |
| `policy.writableEntities` | `[]` | 写实体白名单，必须与适配器 `writable` 同时满足 |

完整字段与默认值见 `lib/config.js`。

---

## 工具

### 只读（始终注册）

| 工具 | 作用 |
|---|---|
| `erp_status` | 适配器健康、入站/出站队列、台账大小、策略、密钥来源（不返回值） |
| `erp_query` | 按实体查询，字段/行数受 allow-list 与 `maxQueryRows` 限制 |
| `erp_get` | 按 id 取单条记录 |
| `erp_ledger` | 查看 inbox/outbox 状态、尝试次数、下次重试、错误 |
| `erp_audit` | 从当前 Session 日志折叠 ERP 工具调用与审批证据 |

### 写（仅 `allowWrite: true` 注册）

| 工具 | 审批 | 说明 |
|---|---|---|
| `erp_create_draft` | 每次 | 只创建草稿，不提交 |
| `erp_commit` | 每次 | 调用适配器配置的 `commitMethod` |
| `erp_retry` | 每次 | 重投失败的 inbox/outbox 记录（`allowResend` 控制） |

所有工具的输出都会被序列化成 lossless JSON；工具内部不会把 ERP 原始响应直接透传成长文本。

---

## 适配器

### mock

内存演示数据，覆盖 `purchase_order`、`sales_order`、`vendor`、`invoice`；支持 query/get/createDraft/commit。用于 UI 演示、契约测试和新人培训，不连接网络。

### odoo

Odoo 12–18 的 JSON-RPC：

```yaml
adapter:
  id: odoo
  url: https://odoo.example.com
  db: production
  username: dsh-api
  passwordRef: ODOO_PASSWORD
  models:
    purchase_order: purchase.order
    sale_order: sale.order
    partner: res.partner
  fields:
    purchase_order: [name, partner_id, amount_total, state, date_order]
  writable:
    purchase_order:
      commitMethod: button_confirm
```

密码每次操作通过 `ctx.credentials.resolve(passwordRef)` 解析（5 分钟 uid 缓存），轮换后下一次调用生效。

### http-gateway

给传统 ERP 的最小中间件契约。客户在自己的 ERP 侧写一个薄网关，插件只认下面五个端点：

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/query` | `{entity, filter, fields, limit, offset}` | `{rows, total}` |
| GET | `/documents/{entity}/{id}` | — | `{doc}` 或记录本身 |
| POST | `/drafts` | `{entity, data}` | `{docId}` |
| POST | `/documents/{entity}/{id}/commit` | `{data}` | `{state}` |
| GET | `/health` | — | `{ok:true,...}` |

完整契约见 [docs/adapter-contract.md](docs/adapter-contract.md)。

要接金蝶云星空、用友 U8/NC、SAP ECC，优先走 `http-gateway` + 客户中间件；等字段映射稳定后再考虑原生 adapter。

---

## 安全边界

1. **入站只接受 HMAC-SHA256 签名**：`HMAC(secret, "${timestampHeader}.${rawBody}")`，时间窗默认 ±5 分钟；签名比较是 constant-time。
2. **幂等键由 ERP 给**：`(source, deliveryId)`；同 id 同 body 返回 202 duplicate，同 id 不同 body 返回 409，不静默覆盖。
3. **先落盘再 202**：202 只代表"签收"，不代表"办完"；后台泵负责建 Session/投递。
4. **入站会话只读**：创建后立即切到 `read-only` 预设并**校验投影确实生效**；`permissionPresets` 不可用则拒绝创建，不会降级成 workspace-write。
5. **提示注入防护**：ERP 事件原文作为"untrusted data"放进 prompt，并带投递标记；入站会话没有注册写工具（`allowWrite` 管的是全局注册，入站会话本身还被只读沙箱约束）。
6. **写工具默认不存在**：不是"注册了再拦"；只有 `allowWrite` + `writableEntities` + 适配器 `writable` 三者同时满足才注册。
7. **逐次审批**：`ctx.approval.request()` 要求有一个打开的回合和可用的应答者；`unavailable` / `rejected` / `cancelled` 都不写 ERP。
8. **数据最小化**：outbox 默认只带会话 id、回合、状态、最终答复摘要、工具名与成功/失败；不默认带工具参数（`includeToolArguments: false`）。
9. **密钥不落 patch**：`credentialRef` → 环境变量 → 0600 文件；日志只打印来源，不打印值。
10. **SSRF 基线**：只允许 http(s)、禁止 URL 内嵌凭据、永远拒绝云元数据地址；私有网段默认允许（ERP 是内网系统），可用 `allowPrivateNetwork: false` 收紧。
11. **无沙箱提醒**：DSH Host 插件运行在进程内，能碰文件、网络、凭据。企业评审时请把"源码可审、默认只读、写回双人确认、依赖为零"作为交付材料。

---

## 生产部署清单

- [ ] `dataDir` 指向独立磁盘目录，单实例独占；多实例改用 SQLite/Postgres 台账（见方案文档）
- [ ] `ingress.mode: standalone`，只绑 `127.0.0.1`；外层 Caddy/Nginx 终结 TLS，只反代 `/erp/events`
- [ ] `signature.autoGenerate: false`，密钥写入 DSH 凭据 seam 或进程环境；≥32 字节随机值
- [ ] ERP 侧固定 `deliveryId = 单据号 + 事件名 + 版本号`，不要用时间戳
- [ ] `outbound.targetUrl` 使用内网网关；在网关侧校验 `x-dsh-signature` 与 `idempotency-key`
- [ ] `inbound.permissionPreset: read-only`；不要给 ERP 会话配 `danger-full-access`
- [ ] `policy.allowWrite` 按需开启，`writableEntities` 最小化
- [ ] `includeSummary` 按合规要求决定；财务金额/供应商等字段在 ERP 侧脱敏
- [ ] 监控 `GET /erp/health`、`erp_status` 的 `outbound.pending/failed`、`inbox.states.failed`
- [ ] 定期备份 `inbox.jsonl` / `outbox.jsonl`；升级前跑契约测试

---

## 运维

### 健康检查

```http
GET /erp/health
```

返回 adapter、ingress 模式、inbox 条目数与状态计数；不返回任何事件内容。

### 常见故障

| 现象 | 先看 | 处理 |
|---|---|---|
| ERP 说 202 但没会话 | `erp_ledger kind=inbox` | 看 `error`；`failed` 用 `erp_retry kind=inbox id=...` |
| 会话出现但没回调 | `erp_ledger kind=outbox` | 看 `attempts/nextAt/error`；4xx 修契约后 `erp_retry` |
| 写工具不存在 | `erp_status.policy` | `allowWrite` / `writableEntities` / 适配器 `writable` |
| 审批总是拒绝 | Session 权限 | 切到 `workspace-write`（`ask`），确认审批 UI 可用 |
| 端口被占 | Host 日志 | 改 `ingress.port`；插件不会崩，只是 ingress unavailable |

### 台账修复

台账是追加式 JSONL，最后半行损坏会在启动时被忽略（`erp_status` 的 `corrupt` 计数）。不要手工改状态；需要重投时用 `erp_retry`，它会追加事实而不是改写历史。

---

## 测试

```powershell
# 纯逻辑 + 入站 HTTP 契约（12 项）
node test/unit.test.mjs

# 出站签名/幂等/重试 + 写工具审批 + 入站泵（不启动 DSH）
node test/e2e.mjs
```

活体验收（本机已执行）：

| 验收项 | 结果 |
|---|---|
| 签名事件 → 202 | ✅ `PO-2026-0001:approved:v1` |
| 重复 deliveryId | ✅ 202 duplicate |
| 同 id 不同 body | ✅ 409 conflict |
| 入站会话权限 | ✅ `sandbox=read-only`，`preset=read-only` |
| 入站工作区隔离 | ✅ `<dataDir>/workspace` |
| `turn/end` → outbox | ✅ `session:1 done`，mock ERP 收到 |
| 第二条事件（UTF-8 中文） | ✅ 签名投递成功 |
| 写工具 | ✅ 默认不注册；`allowWrite` 后逐次审批；拒绝时 ERP 无变化 |

详细证据与命令见 [docs/implementation-plan.md](docs/implementation-plan.md#12-验收记录) 与 [docs/acceptance-evidence.md](docs/acceptance-evidence.md)。

---

## 目录结构

```
dsh-erp-bridge/
├─ index.js                 # Host 插件入口（apply + inject）
├─ cordis.patch.yml         # 本地演示 bundle patch
├─ lib/
│  ├─ bridge.js             # 生命周期编排
│  ├─ config.js             # 配置默认值与校验
│  ├─ ingress.js            # HMAC 入站监听器
│  ├─ inbox.js              # 入站泵：建会话/只读/提示词/重试
│  ├─ outbox.js             # turn/end 投影与可靠投递
│  ├─ ledger.js             # JSONL 台账与折叠
│  ├─ secrets.js            # 凭据 seam / 环境 / 0600 文件
│  ├─ sessions.js           # Session 跟踪、审计折叠
│  ├─ tools.js              # erp_* 工具与审批门控
│  ├─ util.js               # HMAC/退避/URL/JSON 工具
│  └─ adapters/             # mock / odoo / http-gateway
├─ mock-erp/server.mjs      # 演示用 ERP 接收器与事件代理
├─ test/                    # 单元 / 端到端 / 实时事件脚本
├─ docs/
│  ├─ implementation-plan.md
│  ├─ acceptance-evidence.md
│  ├─ adapter-contract.md
│  └─ security-checklist.md
├─ locale/{en,zh}.json
└─ icon.svg
```

---

## 许可

MIT。`mock` 适配器中的企业名称、税号、金额均为演示数据，不对应任何真实主体。
