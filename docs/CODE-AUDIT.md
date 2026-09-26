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
- [ ] 全部页面 JS/WXML/WXSS/JSON
- [ ] 全部 service / helper
- [ ] dailyReminder 全部实现与测试
- [ ] mediaCleanup 全部实现与测试
- [ ] legacyV2Migration 全部实现与测试
- [ ] renianApi 全部 action dispatch 与剩余业务函数
- [ ] 全部 PowerShell / CMD 脚本
- [ ] 全部 API 测试逐文件核对
- [ ] GitHub Actions
- [ ] 文档与代码契约交叉检查

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

## 4. 审查原则

- 不把理论风险直接写成生产 Bug。
- 每个问题尽量给出具体源码路径、触发顺序和复现条件。
- 先完整审查，再集中修改；避免边审查边产生未经验证的代码改动。
- 如果发现确定性 Bug，再单独提出最小修改方案。
