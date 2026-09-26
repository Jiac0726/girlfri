# girlfri 全仓库代码审查记录

> 审查对象：`Jiac0726/girlfri`  
> 审查分支：`main`  
> 审查开始：2026-09-27  
> 目标：逐文件检查源码、配置、测试与部署脚本；区分“已确认问题 / 潜在风险 / 已有防护 / 待验证”。

## 1. 当前进度

### 已完成初检
- [x] 根目录配置与文档清单
- [x] `app.js` / `app.json`
- [x] `services/cloud.js`
- [x] `services/entry-drafts.js`
- [x] `services/entry-view.js`
- [x] `cloudfunctions/renianApi/v2-core.js`
- [x] `cloudfunctions/renianApi/v2-media.js`
- [x] `cloudfunctions/renianApi/v2-pairs.js`
- [x] `cloudfunctions/renianApi/v2-visibility.js`
- [x] `cloudfunctions/renianApi/v2.js` 主业务入口
- [x] `tests/frontend/pages.test.js`
- [x] `tests/renian-api/*` 部分测试结构
- [x] V2 数据库 schema / storage rules
- [x] legacyV2Migration 主迁移流程

### 尚待逐文件检查
- [x] 全部页面 JS/WXML/WXSS/JSON（事件绑定与样式结构已交叉检查）
- [x] 全部 service / helper
- [x] dailyReminder 全部实现与测试
- [x] mediaCleanup 全部实现与测试
- [x] legacyV2Migration 全部实现与测试
- [x] renianApi 全部 action dispatch 与剩余业务函数
- [x] 全部 PowerShell / CMD 脚本
- [x] 全部 API 测试逐文件核对
- [x] GitHub Actions
- [x] 文档与代码契约交叉检查（发现 RELEASE-CHECKLIST 历史内容）

## 2. 已确认 / 高可信问题

### F-001 编辑页可能产生无意义草稿
**状态：已从源码路径确认，待决定修复方式。**

当前 `entry.js` 在页面退出时调用 `persist()`，而 `persist()` 会把当前编辑页内容写入 draft。源码目前没有明确的 dirty 状态来区分：

1. 用户真正修改后离开；
2. 用户只是打开已有记录后直接返回。

因此“只查看/未修改”也可能留下草稿。对于编辑已有记录的场景，这会让后续进入页面时优先读取旧草稿，而不是服务端最新版本。

**建议验证：**
- 打开已有 entry，不修改直接返回，再次进入；
- 服务端在两次进入之间把 entry version 从 N 更新到 N+1；
- 检查第二次进入是否仍显示旧 draft。

### F-002 编辑草稿可能长期优先于服务端最新状态
**状态：源码已确认存在该设计风险。**

如果已有 draft，entry 页面会优先恢复 draft。对于“新建未提交内容”这是合理的；对于“编辑已有 entry”，需要 dirty/来源标记，否则旧 draft 可能遮蔽服务器的新版本。

### F-003 media.prepare 存在并发窗口
**状态：潜在并发风险，尚未证明为生产 Bug。**

当前 `media.prepare` 的幂等 mutation 完成后，会在事务外：
1. 读取 media；
2. 若没有 `stagingFileID`，调用 `getUploadMetadata()`；
3. 再开启独立事务写入 `stagingFileID`。

两个相同请求并发时可能都观察到没有 stagingFileID，分别申请上传元数据并竞争写入。现有 race tests 尚未看到针对该窗口的专门测试。

**下一步：**
加入延迟版 `getUploadMetadata()` 并发测试，确认最终 stagingFileID 是否唯一且稳定。

## 3. 已确认有防护的关键链路

### P-001 请求幂等
`requestId + action + OPENID` 形成 operation key；同 requestId 重试可复用第一次结果，payload 改变则应拒绝。

### P-002 Entry 并发版本控制
更新/删除使用 `expectedVersion`，避免旧页面覆盖新数据。

### P-003 页面旧请求防覆盖
index/review/feed 使用 token/sequence 检查，旧异步响应不能覆盖新状态。

### P-004 媒体真实内容校验
服务端不仅检查扩展名，还检查实际文件签名与大小，并由服务端生成 published 路径。

### P-005 私有备忘录权限
private memo media 使用 ownerOpenid 与 memo 归属校验。

### P-006 Pair join 事务竞态
绑定竞争、邀请码替换、过期邀请码等已有 race test 覆盖。

### P-007 迁移防重复/防源变化
legacy migration 使用 source fingerprint、progress marker、目标集合非空保护和完成 receipt。

### F-004 心意券“写入成功 + 列表刷新失败”会丢失重试凭据
**状态：已确认，确定性前端状态 Bug。**

`pages/privileges/privileges.js` 的 `gift()` 在 `api.giftCoupon()` 成功后立即把 `this._gift` 置空、清空标题/备注，再调用 `load()` 刷新列表。如果写入已经成功但随后 `load()` 因网络错误失败，catch 会把页面置为 uncertain，但原 requestId/内容已经丢失。

结果是按钮显示“重试确认”，实际上没有原操作可重试；用户重新填写后会生成新的 requestId。对于创建类操作，这可能产生重复心意券，也会让“重试确认”语义失效。

**最小修复方向：**
先保留 `_gift`，直到刷新成功；刷新失败时继续使用原 requestId 重试，不重新生成券。

### F-005 共同约定“写入成功 + 列表刷新失败”同样丢失原操作
**状态：已确认，确定性前端状态 Bug。**

`pages/permissions/permissions.js` 的 `submitAgreement()` 在 `api.proposeAgreement()` 成功后立即：
1. 清除 requestId；
2. 清空 `_pendingProposal`；
3. 清空编辑内容；
4. 再调用 `loadAgreements()`。

如果第 4 步失败，页面会进入 uncertain，但原 proposal 和 requestId 已不可恢复。再次点击“重试确认”不能复用原提议，甚至表单已经清空。

### F-006 私密备忘“写入成功 + 列表刷新失败”也丢失原操作
**状态：已确认，确定性前端状态 Bug。**

`pages/profile/profile.js` 的 `saveMemo()` 在 create/update 成功后先调用 `resetMemoEditor()`，然后才执行 `listPrivateMemos()`。若列表读取失败，catch 看不到 `_memoPending`，因此不能进入真正的“待确认重试”路径；编辑内容也已经被清空。

这与当前页面文案“保存结果待确认，请重试确认”的设计不一致。对新建备忘录尤其可能造成重复条目。

### F-007 心意券/约定/备忘缺少“mutation 成功后刷新失败”的回归测试
**状态：已确认，测试缺口。**

`tests/frontend/pages.test.js` 目前覆盖了 mutation 本身超时、重试保持 requestId 等场景，但没有覆盖“服务端 mutation 已经返回成功，随后列表刷新请求失败”的两阶段场景。这正是 F-004/F-005/F-006 的触发条件。

## 5. 新增发现

### D-001 RELEASE-CHECKLIST 与当前 v2 代码不一致
**状态：已确认，文档问题。**

`docs/RELEASE-CHECKLIST.md` 仍包含旧版架构内容，例如主导航、旧集合、旧索引和旧安全术语，与当前 `app.json`、`README.md`、`V2-DEPLOY.md` 不一致。该文档后续应单独更新，避免部署/提审人员按旧流程操作。

### D-002 当前源码检查脚本不是完整静态分析器
**状态：已确认，属于测试能力边界。**

`scripts/check-source.js` 主要检查 JS/JSON 语法、页面资源存在性和 tab 路由合法性，不检查 WXML 事件与 JS 方法的对应关系、WXML 字段、service action 与云函数 action 的双向契约，也不检查部署 schema 一致性。因此 “Source check passed” 不能视为完整静态检查。

### D-003 Cloud SDK 依赖版本不统一
**状态：已确认，维护风险。**

`cloudfunctions/renianApi/package.json` 使用 `@cloudbase/node-sdk 3.18.1`，而 `cloudfunctions/mediaCleanup/package.json` 使用 `3.17.2`。两者都依赖 Node SDK 做服务端数据库/存储操作。当前没有证据表明这会立即导致运行错误，但线上行为和依赖修复路径不一致，后续升级应统一验证。

### P-008 service action 与后端路由已完成双向核对
当前 `services/cloud.js` 的 38 个业务 action 与 `cloudfunctions/renianApi/v2.js` 的 switch 路由一一对应，没有发现客户端调用了不存在 action，或后端暴露而前端 wrapper 缺失的 action。


### F-008 私密备忘录 mutation 成功后，服务端响应组装仍可能把成功伪装成失败
**状态：已确认，服务端确定性一致性风险。**

`memoCreate()` / `memoUpdate()` 在数据库事务成功后，会立即调用 `memoView()` 返回结果；而 `memoView()` 对每张私密备忘录图片调用严格模式的 `privateMemoImages()`。只要其中任意一张图片无法取得临时 URL，就可能抛出 `MEDIA_URL_FAILED`，导致客户端收到失败，即使备忘录数据已经提交。

这和 `entryCreate()` / `entryChange()` 不同：entry 已专门用 `committed=true` 的容错方式处理“写入成功但图片签名失败”，不会把已经提交的业务写入包装成失败。因此当前 memo 链路存在不一致。

客户端 `isUncertain()` 不把 `MEDIA_URL_FAILED` 视为不确定错误，相关页面可能清掉 pending 并允许用户重新提交，从而产生重复备忘录的风险。

### F-009 私密备忘图片单点故障会阻断整个个人页加载
**状态：已确认，确定性可用性问题。**

`pages/profile/profile.js` 的 `loadProfile()` 用 `Promise.all()` 同时加载个人资料、提醒、私密备忘和想念提醒设置。其中 `api.listPrivateMemos()` 对所有备忘录图片使用严格签名：任意一张已存储但当前无法生成临时 URL 的图片，都可能使整个 `memoList` 失败，进而使 `Promise.all()` 整体进入错误分支。

结果是某一张私密图片不可用时，不只是该图片失败，而可能连带影响个人页其它本来可正常读取的资料、提醒和统计展示。页面目前虽然在单独预览图片时支持“失败后再取 URL”，但首次整页加载没有同等容错。

### P-009 V2 数据库索引与当前服务端查询形态已完成交叉核对
当前 `config/database.v2.json` 的 15 个索引覆盖了 entries 的 couple/deleted/month/day + createdAt/_id 分页组合、agreements/coupons 的 couple + createdAt 分页、状态计数查询，以及 media cleanup 使用的 status/expiresAt/confirmLeaseUntil/stagingCleanupPending 等查询键。结合 `v2-core.js` 的统一 keyset `page()` 实现和 workers 的查询方式，本轮没有发现明显的“代码使用了 schema 中不存在索引”的问题。


### V-001 当前审查提交的 GitHub Actions 已通过
审查提交 `876224fa5174e83d9aa79a69417251881f275234` 对应的 `Renian checks` workflow 已完成且 `conclusion=success`。其中 Node 测试与 Windows PowerShell 检查均在该 workflow 中执行。

该结果仅证明仓库现有 CI 检查通过，不等同于真实微信设备、真实 CloudBase 环境和真实并发条件下的验收。

## 4. 审查原则

- 不把理论风险直接写成生产 Bug。
- 每个问题尽量给出具体源码路径、触发顺序和复现条件。
- 先完整审查，再集中修改；避免边审查边产生未经验证的代码改动。
- 如果发现确定性 Bug，再单独提出最小修改方案。
