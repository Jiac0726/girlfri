# 热念 · 提审前检查清单

> 适用：当前 V2 架构的微信小程序 + CloudBase。
> 目标：提审前同时验证前端、云函数、数据库、媒体和双人绑定主链路。
> 本清单只描述当前仓库的 V2 实际结构；旧版迁移数据另见 `V2-DEPLOY.md` 与 `v2-migrate-legacy.ps1`。
> 本次执行结果与待验收项见 [发布验收记录](RELEASE-VALIDATION-2026-09-27.md)。代码检查通过不代表线上已验收。

## P0 · 核心流程

### 1. 双人绑定主链路
- [ ] 账号 A 可生成 8 位邀请码。
- [ ] 账号 B 可通过邀请码加入。
- [ ] 绑定成功后，双方的 `coupleId` 与成员关系一致。
- [ ] A/B 都能进入「今天 / 日常 / 回顾 / 我们」。
- [ ] 错误邀请码、过期邀请码、自邀、重复绑定均有明确错误状态。
- [ ] 审核测试说明明确写出“需要两个微信账号完成绑定”。

### 2. 日常与回顾
- [ ] 首页可选择评分并进入新建记录页；评分入口只预填，不直接提交。
- [ ] 新建、编辑、删除日常均正常。
- [ ] 同一天允许多条记录。
- [ ] 「回顾」月份切换、上/下月、按日期筛选和分页正常。
- [ ] 月份/日期请求失败时，不会继续展示上一筛选条件的旧记录。
- [ ] 双方记录与单方历史记录的可见性符合当前业务规则。

### 3. 共同约定与心意券
- [ ] 约定发起、接受、拒绝、撤回、结束均可用。
- [ ] 心意券赠送、申请、同意/拒绝、撤销/撤回、历史记录均可用。
- [ ] 网络不稳定时重试使用同一个 requestId，不重复创建业务数据。
- [ ] “写入成功、列表刷新失败”后，页面仍保留原操作上下文，可继续确认。

### 4. 私密备忘录与媒体
- [ ] 私密备忘录只对本人可见。
- [ ] 图片上传、确认、编辑、删除正常。
- [ ] 图片临时 URL 获取失败时，不会把已经提交成功的备忘录表现成“写入失败”。
- [ ] 单张私密图片异常不会阻断整个「我们」页面其它数据加载。
- [ ] 上传中断、过期、未确认文件可由清理任务回收。
- [ ] `media.prepare` 并发调用最终只产生稳定的 stagingFileID。

## P1 · CloudBase V2

### 5. V2 集合
当前业务集合由 `config/database.v2.json` 定义：
- [ ] `v2_users`
- [ ] `v2_couples`
- [ ] `v2_invites`
- [ ] `v2_entries`
- [ ] `v2_agreements`
- [ ] `v2_coupons`
- [ ] `v2_coupon_requests`
- [ ] `v2_media`
- [ ] `v2_operations`

所有集合由云函数服务端访问，前端不直接读写这些集合。

### 6. 数据库索引
- [ ] 按 `config/database.v2.json` 核对全部 16 个 V2 索引已就绪。
- [ ] `v2_operations` 包含按 `createdAt ASC + _id ASC` 的清理索引。
- [ ] 生产环境核对索引实际状态，不只检查代码配置文件。

### 7. 云函数部署
部署以下函数，并确保依赖已安装：
- [ ] `renianApi`
- [ ] `mediaCleanup`
- [ ] `dailyReminder`
- [ ] `legacyV2Migration`（仅在需要迁移旧数据时执行）

部署后使用微信开发者工具/体验版真机验证，不把单纯的 CLI invoke 结果当成完整验收。

### 8. 环境配置
- [ ] 本地 `config/env.local.js` 已配置实际 CloudBase 环境。
- [ ] 本地 `project.private.config.json` 使用真实 AppID。
- [ ] Git 忽略文件中保存 AppID/云环境等本地配置。
- [ ] 不把密钥、上传私钥或真实用户数据提交到仓库。

## P1 · 安全与数据一致性

### 9. 身份与授权
- [ ] 服务端身份只取 `cloud.getWXContext().OPENID`。
- [ ] 所有双人数据访问均经过 membership / ownership 校验。
- [ ] entry / memo / media 均不能通过修改请求参数访问其它用户数据。
- [ ] private memo media 不可被伴侣账号直接签名访问。

### 10. 幂等与版本控制
- [ ] 创建类 mutation 使用 requestId 幂等。
- [ ] 编辑/状态变更使用 expectedVersion。
- [ ] 重试时 payload 不得偷偷改变。
- [ ] 前端 mutation 成功后刷新失败，必须继续保留原 requestId 与原 payload。

## P2 · 自动化检查

提交前至少执行：

```text
node scripts/check-source.js
node --test tests/renian-api/*.test.js tests/frontend/*.test.js
```

当前源码检查还会验证：
- 页面 JS/WXML 的事件处理函数是否可解析到；
- `services/cloud.js` 与 `renianApi/v2.js` 的 action 是否一一对应；
- 页面资源、Tab 路由和 JS/JSON 语法。

### 11. Windows 更新脚本
- [ ] `update-main.cmd` / `update-main-force.cmd` 在目标机器可正常执行。
- [ ] 本地 Git ignored 配置不会被更新脚本覆盖。
- [ ] 强制更新只在明确需要丢弃本地 tracked 修改时使用。

## P2 · 旧数据迁移

仅迁移旧版数据时执行：

1. 按 `V2-DEPLOY.md` 备份并部署临时迁移函数，再运行 `v2-migrate-legacy.cmd`。脚本只支持 `-Yes` 开关，不支持 `prepare` / `plan` 位置参数；它内部依次调用这些云函数 action。
2. 核对脚本打印的 plan 和全部 blocker；仅在确认迁移范围后输入 `MIGRATE_V2` 执行复制。本次收尾不自动运行该脚本，也不使用 `-Yes` 跳过确认。
3. active 关系必须满足：
   - creatorOpenid 存在；
   - partnerOpenid 非空；
   - partnerOpenid 与 creatorOpenid 不同；
   - partnerOpenid 属于 memberOpenids；
   - 两个用户的 coupleId 与关系一致。
4. 迁移过程不能继续写入旧源数据。
5. 完成后保留旧集合作为回退依据，并核对 receipt / source fingerprint / target verification。

## P3 · 提审材料

- [ ] 提供双账号使用说明。
- [ ] 版本描述写清：生成邀请码 → 第二个账号加入 → 双方记录 → 回顾。
- [ ] 隐私保护指引只勾选实际使用的能力和数据类型。
- [ ] 分享路径只携带必要的邀请码信息，不携带 openid。
- [ ] 测试账号、体验版入口和已知限制写在提审备注中。

## 提审后

- [ ] 体验版真机完成双账号绑定和完整主流程。
- [ ] 检查 CloudBase 云函数日志中无持续性 unexpected/internal 错误。
- [ ] 确认媒体清理、提醒任务正常运行。
- [ ] 新版本发布前确认数据库 schema/index 与当前代码一致。

## 附：当前安全基线

以下表示代码机制已实现并有自动化检查，不表示生产配置和真机验收已通过。

| 项目 | 状态 |
|---|---|
| OPENID 服务端身份 | ✅ |
| membership / ownership 授权 | ✅ |
| Entry expectedVersion | ✅ |
| Mutation requestId 幂等 | ✅ |
| 私密备忘录 owner-only | ✅ |
| Media 文件身份与内容校验 | ✅ |
| Media staging / published 隔离 | ✅ |
| legacy migration source fingerprint | ✅ |
| Active partner identity validation | ✅ |
| v2_operations 90 天保留策略 | ✅ |
| WXML handler source check | ✅ |
| Client/server API action contract check | ✅ |
