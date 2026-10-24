# 适配器契约

引擎只认一个接口；厂商差异全部收在这里。本文是 `http-gateway` 的线协议、`odoo` 的映射规则，以及新增适配器的步骤。

---

## 1. 统一概念

| 概念 | 说明 |
|---|---|
| `entity` | 业务实体名，引擎侧稳定标识，例如 `purchase_order` / `vendor` / `invoice` |
| `fields` | 该实体允许暴露的字段白名单；查询和写入都只能碰这些字段 |
| `id` | 厂商单据 id；`erp_get` / `erp_commit` 用它定位 |
| `writable` | 该实体是否允许 draft/commit；还要再过 `policy.writableEntities` |
| `commitMethod` | 厂商的提交/过账动作（Odoo 方法名、网关路径） |

引擎保证：

- 所有适配器方法都可能在 `signal` 取消时被中断；
- 适配器抛错会被工具层转成 `isError` 结果，不会让 Host 崩溃；
- 适配器不得返回非 lossless JSON（BigInt、循环引用、NaN 等）。

---

## 2. HTTP Gateway 契约

适用：用友 U8/NC、金蝶 K3、SAP ECC、自研 MES/OA。客户在自己的 ERP 侧写一个薄网关（.NET/Java/Node 均可），把厂商 API 翻译成下面五个端点。

### 2.1 通用

- Base URL：`adapter.baseUrl`，例如 `http://erp-gateway.internal:8080`
- 鉴权：`Authorization: Bearer <token>`；token 由 DSH 的 `adapter.authRef` 解析
- 编码：UTF-8 JSON
- 超时：`adapter.timeoutMs`（默认 15s）
- 错误：非 2xx 返回 `{ "error": "..." }`；引擎会把状态码与错误文本写入台账

### 2.2 `POST /query`

请求：

```json
{
  "entity": "purchase_order",
  "filter": { "status": "approved", "q": "PO-2026" },
  "fields": ["id", "number", "vendor", "amount", "currency", "status"],
  "limit": 20,
  "offset": 0
}
```

响应：

```json
{
  "rows": [
    { "id": "PO-2026-0001", "number": "PO-2026-0001", "vendor": "V-001", "amount": 128000, "currency": "CNY", "status": "approved" }
  ],
  "total": 1
}
```

- `filter` 的等值条件由引擎按白名单校验后传入；`q` 是可选模糊搜索；
- `total` 用于分页；没有就返回 `rows.length`；
- 网关必须只返回 `fields` 中的字段（多返回会被引擎裁剪）。

### 2.3 `GET /documents/{entity}/{id}`

响应：

```json
{
  "doc": {
    "id": "PO-2026-0001",
    "number": "PO-2026-0001",
    "vendor": "V-001",
    "amount": 128000,
    "currency": "CNY",
    "status": "approved"
  }
}
```

或直接返回记录对象。找不到返回 `404`（引擎转成 `null`）。

### 2.4 `POST /drafts`

请求：

```json
{
  "entity": "purchase_order",
  "data": { "vendor": "V-001", "amount": 1000, "currency": "CNY" }
}
```

响应：

```json
{ "docId": "DRAFT-20261024-0001", "doc": { "id": "DRAFT-20261024-0001", "status": "draft" } }
```

- 只创建草稿，不得提交/过账；
- `docId` 必填；
- 字段必须在实体白名单内。

### 2.5 `POST /documents/{entity}/{id}/commit`

请求：

```json
{ "data": { "reason": "created by dsh-erp-bridge after approval" } }
```

响应：

```json
{ "state": "approved", "doc": { "id": "PO-2026-0001", "status": "approved" } }
```

- 这是产生财务/库存后果的动作，必须由 DSH 侧逐次审批后才调用；
- 网关应校验单据当前状态，避免重复提交；
- 如果厂商接口不支持幂等，网关自己按 `docId` 做状态机幂等。

### 2.6 `GET /health`

```json
{ "ok": true, "erp": "yonyou-u8", "version": "16.5" }
```

用于 `erp_status` 的 `adapterHealth`；不要返回凭据或业务数据。

### 2.7 可选 `GET /changes?since=<ms>`

用于没有事件推送的老 ERP：

```json
{
  "changes": [
    { "at": 1792844692826, "entity": "purchase_order", "id": "PO-2026-0001", "operation": "approved" }
  ]
}
```

P3 的对账泵用它合成事件；当前实现保留接口但未启用定时对账。

### 2.8 回调接收（DSH → ERP）

`outbound.targetUrl` 指向网关的另一个端点，例如 `POST /dsh/turn-result`。网关必须：

1. 读取原始 body；
2. 用共享密钥验证：

   ```
   HMAC-SHA256(secret, `${x-dsh-timestamp}.${rawBody}`) === x-dsh-signature (去掉 "sha256=")
   ```

3. 校验时间窗（建议 ±5 分钟）；
4. 按 `Idempotency-Key` 去重；
5. 返回 2xx 表示已落库；
6. 不要对可重试错误返回 4xx；用 5xx/429。

响应体可以是任意 JSON；DSH 只读取状态码。

---

## 3. Odoo 映射

### 3.1 配置

```yaml
adapter:
  id: odoo
  url: https://odoo.example.com
  db: production
  username: dsh-api
  passwordRef: ODOO_PASSWORD
  timeoutMs: 15000
  models:
    purchase_order: purchase.order
    sale_order: sale.order
    partner: res.partner
    invoice: account.move
  fields:
    purchase_order: [name, partner_id, amount_total, state, date_order]
    sale_order: [name, partner_id, amount_total, state, date_order]
    partner: [name, email, vat, country_id]
    invoice: [name, partner_id, amount_total, state, move_type]
  writable:
    purchase_order:
      commitMethod: button_confirm
```

### 3.2 调用映射

| 引擎方法 | Odoo JSON-RPC |
|---|---|
| 登录 | `service: common, method: login, args: [db, username, password]` |
| `query` | `execute_kw(db, uid, password, model, 'search_read', [domain], {fields, limit, offset, order})` + `search_count` |
| `get` | `search_read` with `[['id','=',id]]`, `limit: 1` |
| `createDraft` | `execute_kw(..., 'create', [[values]])` + `read` |
| `commit` | `execute_kw(..., commitMethod, [[id]])` + `read` |
| `health` | `login` 返回 uid |

### 3.3 约定

- `entity` → `models[entity]`；未配置的实体不可达；
- `fields` 是暴露白名单；`filter` 的键必须在白名单；
- `q` 只在 `name` 字段存在时生效（`ilike`）；
- 密码每次操作通过 credential seam 解析；uid 缓存 5 分钟，密码轮换后下一次调用重新登录；
- `commitMethod` 必须显式配置，默认不提交；
- Odoo 的 `id` 是整数；`erp_get`/`erp_commit` 会校验。

### 3.4 已验证/未验证

- 代码路径与 JSON-RPC 形状按 Odoo 公开协议实现；
- **未在真实 Odoo 实例上做活体验收**；上线前请用客户测试库跑契约测试（录 `search_read`/`create`/`button_confirm` 的真实响应回放）。

---

## 4. Mock 适配器

- 纯内存，6 条种子数据：2 张采购单、1 张销售单、2 个供应商、1 张发票；
- `purchase_order` 可写；其他实体只读；
- `createDraft` 生成 `DRAFT-YYYYMMDD-NNNN`，状态 `draft`；
- `commit` 把状态改为 `approved`；
- 用于演示、UI 联调、契约测试，不连接网络。

---

## 5. 新增适配器

### 5.1 实现接口

在 `lib/adapters/<name>.js` 导出一个类：

```js
export class MyErpAdapter {
  constructor(config, { secrets }) { /* validate config, resolve URLs */ }
  id = 'my-erp'
  entityNames() { return Object.keys(this.config.entities) }
  entityPolicy(entity) { /* { fields, writable } or throw */ }

  async query(entity, filter, options, signal) { /* { rows, total, fields } */ }
  async get(entity, id, signal) { /* doc | null */ }
  async createDraft(entity, data, signal) { /* { docId, doc? } */ }
  async commit(entity, id, data, signal) { /* { docId, state, doc? } */ }

  async health(signal) { /* { ok: true, ... } */ }
  async pollChanges(since, signal) { /* [] or changes */ }
  async buildResultWrite(turn) { return null }
}
```

然后在 `lib/adapters/index.js` 注册：

```js
case 'my-erp':
  return new MyErpAdapter(config, deps)
```

并在 `lib/config.js` 的 `normalizeAdapter` 增加校验分支。

### 5.2 硬性要求

- **字段白名单**：`query`/`get`/`createDraft` 都只能碰 `entityPolicy().fields`；
- **写实体标记**：`entityPolicy().writable` 必须与 `policy.writableEntities` 同时满足；
- **错误可读**：抛出的错误要包含厂商错误码/字段名，便于台账诊断；不要包含密码/token；
- **超时/取消**：所有网络调用接受 `signal`，并与 `AbortSignal.timeout(timeoutMs)` 组合；
- **纯 JSON**：返回值必须可 JSON 序列化；
- **不缓存凭据**：每次操作通过 `secrets.resolve` 解析（uid/会话可短缓存）。

### 5.3 契约测试

1. 录一次真实响应（脱敏）；
2. 在 `test/` 下回放，断言映射后的 `rows`/`doc`/`docId`/`state`；
3. 断言不允许的字段/实体被拒绝；
4. 断言 4xx/5xx 错误被转成可读错误；
5. ERP 升级时先跑这组测试。

---

## 6. 状态码与重试约定

| 场景 | 网关/ERP 应返回 | DSH 行为 |
|---|---|---|
| 成功落库 | 2xx | done |
| 暂时不可用 | 503 / 429 / 408 | 退避重试 |
| 字段/契约错误 | 400 / 422 | 永久失败，人工修 |
| 鉴权失败 | 401 / 403 | 永久失败，检查凭据 |
| 找不到单据 | 404 | 工具返回 null / 永久失败 |
| 重复幂等键 | 2xx（幂等） | done |

不要把"数据库暂时锁表"返回 400；那会让 DSH 放弃重试。
