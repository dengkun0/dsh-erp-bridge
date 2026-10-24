# 安全与部署检查清单

> 面向客户 IT 评审与上线前自检。每一项都能在代码或台账里找到对应实现；不要只在 PPT 上打勾。

---

## 1. 网络

- [ ] `ingress.mode: standalone`，`host: 127.0.0.1`，只监听回环
- [ ] 外层 Caddy/Nginx 终结 TLS，只反代 `/erp/events` 与 `/erp/health`
- [ ] 其它路径返回 404；不要把 3081 整个暴露到内网/公网
- [ ] 防火墙只允许 ERP 中间件 IP 访问反代
- [ ] 出站 `targetUrl` 只指向内网 ERP 网关；`allowPrivateNetwork` 按需
- [ ] 禁止 `http://169.254.169.254`、`100.100.100.200`、云元数据域名（代码已硬拒）
- [ ] 禁止 URL 内嵌用户名/密码（代码已硬拒）

## 2. 签名与重放

- [ ] 密钥 ≥32 字节随机值；生产 `signature.autoGenerate: false`
- [ ] 密钥经 DSH 凭据 seam 或进程环境注入，不写 `cordis.patch.yml`
- [ ] ERP 侧签名：`HMAC-SHA256(secret, "${timestampHeader}.${rawBody}")`
- [ ] 时间窗 ±5 分钟（`timestampWindowSec`）；ERP/DSH 都开 NTP
- [ ] 签名比较 constant-time（代码 `timingSafeEqual`）
- [ ] `deliveryId` 稳定：单据号 + 事件名 + 版本号
- [ ] 同 id 同 body → 202 duplicate；同 id 不同 body → 409（代码已实现）
- [ ] 回调侧同样验签 + `Idempotency-Key` 落库去重

## 3. 密钥生命周期

- [ ] 生产使用 credential seam（`secretRef`），可轮换
- [ ] 轮换后下一次请求生效（每次请求 resolve，不缓存）
- [ ] `dataDir/secret` 仅作为试点回退；NTFS ACL 限制到运行账户
- [ ] 日志/`erp_status` 只显示来源，不显示值
- [ ] ERP API 凭据（Odoo `passwordRef`、网关 `authRef`）同样走 seam
- [ ] 离职/交接时轮换所有密钥

## 4. 权限与写回

- [ ] 入站 `permissionPreset: read-only`；代码会校验 projection 确实生效
- [ ] 入站工作区 `<dataDir>/workspace`，与 profile 隔离
- [ ] `policy.allowWrite` 默认 false；按需开启
- [ ] `policy.writableEntities` 最小化（例如只开 `purchase_order`）
- [ ] 适配器 `writable` 与实体白名单同时满足才注册写工具
- [ ] 每次 `erp_create_draft` / `erp_commit` 都过 `ctx.approval`
- [ ] 审批 `unavailable`/`rejected`/`cancelled` → 不写
- [ ] 不要把 ERP 会话配成 `danger-full-access`
- [ ] 审批 UI 可用；如果部署把策略设为 `never`，写工具会全部拒绝（预期）

## 5. 数据最小化

- [ ] `outbound.scope: linked`（只回写 ERP 触发的会话）
- [ ] `outbound.includeSummary` 按合规要求；敏感场景设 false
- [ ] `outbound.includeToolArguments: false`（默认）
- [ ] 回调只带 sessionId/turn/status/摘要/工具名；明细让 ERP 反查
- [ ] 财务金额、供应商、税号等按客户要求脱敏
- [ ] `erp_ledger` 不返回事件原始 `data`，只返回实体与状态
- [ ] 日志不打印事件原文、不打印凭据

## 6. 台账与恢复

- [ ] `dataDir` 独立磁盘、单实例独占
- [ ] 定期备份 `inbox.jsonl` / `outbox.jsonl`
- [ ] 监控 `corrupt` 计数；最后半行损坏会被忽略
- [ ] `failed` 记录必须人工确认后再 `erp_retry`
- [ ] 不要手工改 JSONL 状态；用追加事实
- [ ] 多实例必须换 SQLite/Postgres，不能共享文件

## 7. 审计

- [ ] `erp_audit` 能从 Session 日志回答：谁、调了什么、参数、结果、谁批准
- [ ] `approval/asked` 与 `approval/decided` 成对出现
- [ ] 审批理由不包含不必要敏感信息（代码已截断 240 字）
- [ ] Session 日志按企业保留期归档
- [ ] 审计导出包含 sessionId/turn/toolCallId，便于与 ERP 日志对账

## 8. 运维

- [ ] `GET /erp/health` 纳入监控
- [ ] `erp_status` 的 `outbound.pending/failed`、`inbox.states.failed` 告警
- [ ] 401 计数告警（密钥错误/时钟漂移/攻击）
- [ ] 409 计数告警（ERP 侧 deliveryId 生成有 bug）
- [ ] 4xx failed 告警（字段契约变化）
- [ ] 升级前跑 `node test/unit.test.mjs` 与 `node test/e2e.mjs`
- [ ] 保留回滚路径：`remove_bundle` + 台账不删

## 9. 事件响应

| 事件 | 动作 |
|---|---|
| 密钥泄露 | 立即轮换 seam/环境变量；检查 401/409 日志；评估重放 |
| ERP 被入侵 | 停 `ingress.enabled`/`outbound.enabled`；保留台账；法务/客户流程 |
| 发现越权写 | 停 `allowWrite`；从 Session 日志导出审批链；核对 ERP 单据 |
| 台账损坏 | 停插件；备份；用最后可解析行恢复；不要手工伪造 `done` |
| 端口冲突 | 改 `ingress.port`；插件会记 `ingress unavailable`，不崩溃 |

## 10. 给客户 IT 的五个问题

1. 你们能让 ERP 对每个事件生成稳定的 `deliveryId` 吗？
2. 你们的回调接口能验 HMAC 并按 `Idempotency-Key` 去重吗？
3. 你们的 ERP 写接口支持"草稿"和"提交"分离吗？
4. 谁能批准 DSH 的写回？审批记录保留多久？
5. 哪些字段绝对不能出 ERP（金额/供应商/税号/成本）？

如果第 1、2 题答"不能"，先做只读 + 对账，不要上写回。
