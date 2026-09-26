# v2 切换、旧数据继承与验收

代码准备完成不代表云端已切换。本目录默认 AppID 是占位值，`config/env.local.js` 由本机生成。

## 1. 原则

v2 **继承旧数据，不要求老用户重新绑定**。

迁移过程中：

- 旧 `couples / couple_users / ratings` 始终保留，迁移只复制、不删除；
- 原 `coupleId` 继续作为 v2 关系 ID；
- 旧评价转换成历史日常，原“很好 / 还好 / 有点糟”打分继续显示，但不显示“旧版评价”标签；旧版单方未完成互评的记录继续仅作者可见，避免迁移造成历史隐私泄露；
- 旧心情、提醒设置、权限、特权卡一并继承；
- 任何无法安全对应的数据都会让迁移停止，不允许静默跳过；
- 若 v2 目标集合已有真实数据，首次迁移会停止，避免覆盖。

## 2. 先做备份与云资源准备

1. 保存当前线上小程序与云函数版本号，并记录当前代码提交作为回滚点。
2. 运行 `database-preflight.ps1`。它只读导出旧 `couples / couple_users / ratings` 到 `backups/cloudbase/<时间戳>/raw/`，不修改数据库。
3. 核对导出文件、条数和 `PRECHECK.txt`。只有预检通过才继续。
4. **不需要手动创建 9 个 v2 集合和 14 个索引。** 部署下面的临时迁移函数后，`v2-migrate-legacy.cmd` 会自动创建缺失集合，并按 `config/database.v2.json` 自动创建索引。
5. 应用 `config/storage.rules.v2.json`，确认客户端只能写自己的暂存路径，不能直接读发布区或覆盖别人的文件。数据库访问策略仍需按线上 CloudBase 的当前策略体系核验为“客户端不可直接读写”；自动建表/建索引不等于自动修改线上鉴权策略。

旧 `database-migrate.ps1` 不是 v2 数据继承脚本，不要用它代替下面的迁移。

## 3. 部署临时迁移函数并继承旧数据

在微信开发者工具中部署：

```text
cloudfunctions/legacyV2Migration
```

选择：

**上传并部署：云端安装依赖（不上传 node_modules）**

建议迁移期间把该函数超时设置到 120 秒。它拒绝带微信 OPENID 的小程序端调用，只用于 CloudBase CLI / 控制台管理员调用。

随后在项目根目录运行：

```powershell
.\v2-migrate-legacy.cmd
```

脚本会执行：

1. 再做一次最新旧库完整备份；
2. 调用 `legacyV2Migration prepare` 自动创建缺失的 9 个 `v2_` 集合；
3. 读取 `config/database.v2.json`，通过 CloudBase CLI 自动创建 14 个复合索引；
4. 调用 `plan` 检查迁移数量、旧数据一致性和 v2 目标集合；
5. 要求手工输入 `MIGRATE_V2` 后才复制旧数据，最后再次读取迁移状态。

必须看到迁移标记：

```text
status = completed
usersNeedRebind = false
relationshipIdsPreserved = true
```

才允许进入下一步。

如果执行中断，源集合仍未被修改。迁移使用确定性文档 ID，并在 `v2_operations/legacy_v1_to_v2` 保存进度；修复原因后可以重新运行脚本继续完成。**迁移完成前不要让真实用户使用 v2。**

### 旧数据映射

| 旧版 | v2 | 处理方式 |
|---|---|---|
| `couples` | `v2_couples` | 保留原关系 ID、成员、状态 |
| `couple_users` | `v2_users` | 保留绑定、心情、提醒设置 |
| waiting 邀请 | `v2_invites` | 保留邀请码和过期时间 |
| `ratings` | `v2_entries` | 日期、作者、文字、原好/中/差类型全部保留；单方记录保留作者可见性 |
| `couples.permissions` | `v2_agreements` | enabled=true → active；false → ended |
| `couples.privilegeCards` | `v2_coupons` | active/used/revoked → available/used/revoked |
| 已使用特权卡 | `v2_coupon_requests` | 生成一条迁移历史记录，保留“已使用”结果 |

旧评价不会强行映射成新的心情 emoji，避免改变原意；原“很好 / 还好 / 有点糟”作为正常打分展示，前端不展示“旧版评价”迁移标签。

## 4. 部署正式 v2 云函数

迁移完成后部署：

```text
cloudfunctions/renianApi
cloudfunctions/dailyReminder
cloudfunctions/mediaCleanup
```

均选择“云端安装依赖”。

- `renianApi`：建议超时 60 秒、内存 512 MB；函数同时依赖 `wx-server-sdk` 与 `@cloudbase/node-sdk`。前者负责微信身份/存储，后者负责需要 `runTransaction` 的数据库事务；部署时必须选择“云端安装依赖”；
- `dailyReminder`：保留 `subscribeMessage.send` 权限和现有模板 ID，触发器 `dailyRatingReminderTimer` 每 5 分钟运行；
- `mediaCleanup`：触发器 `abandonedMediaCleanup` 每小时第 17 分钟运行；
- 所有时间按 UTC+8；
- 不要给 `dailyReminder`、`mediaCleanup` 暴露普通客户端业务入口。

完成迁移和核验后，删除临时云函数：

```text
legacyV2Migration
```

它不是线上长期组件。

## 5. 切换前数据验收

至少抽查一对已有老用户：

1. 两个微信账号打开 v2 后仍是原来的绑定关系，不出现重新绑定页；
2. 双方旧心情仍存在；
3. 回顾页能看到旧评价转成的历史日常，日期、作者、文字和“很好 / 还好 / 有点糟”打分正确，页面不出现“旧版评价”标签；旧版单方记录只能原作者看到，双方当日都提交过的记录才对双方可见；
4. 旧权限出现在共同约定中；
5. 旧特权卡出现在心意券中，已使用/已撤回状态不被重置；
6. 当天旧版已经评价过的人，`lastSharedDate` 已继承，不应因为切换 v2 被误判成“今天未分享”；
7. 待接受关系仍能继续使用旧邀请码，过期邀请仍按原过期时间处理。

同时比较迁移回执中的数量与备份：

- active/waiting 关系总数；
- 用户总数；
- 旧 ratings 数 = 迁移后的 legacy entries 数；
- permissions 数 = legacy agreements 数；
- privilegeCards 数 = legacy coupons 数。

不一致时不要发布 v2。

## 6. 两个账号的新功能验收

- A 邀请 B，双方各有待接受邀请时 B 接受 A；无效或过期邀请码不破坏原邀请。
- A 只发文字、只发心情、只打分、发照片各一条，B 无需发布即可看到；打分可在“很好 / 还好 / 有点糟”之间修改或取消，A 编辑和删除后 B 刷新一致。
- 相机和相册分别上传 JPG/PNG；中断上传、确认、发布三个阶段并重试，不产生重复记录。
- B 不能改 A 的记录；未绑定第三个账号不能获取双方图片地址。
- 回顾在月底、UTC+8 零点、多页记录时日期正确。
- A 提约定，B 接受；修改提议等待时旧版仍有效。
- A 送券，B 申请，A 拒绝后 B 可重新申请；确认只能兑现一次。
- 默认不提醒；主动允许后，到点未分享只发送一次；当天已分享或分享后删除都不发送。
- 已删除照片和过期未提交照片由定时任务清理；存储删除失败后下次可重试。

## 7. 本地验证

```sh
node scripts/check-source.js
node --test tests/renian-api/*.test.js tests/frontend/*.test.js
```

模拟测试不能替代 CloudBase 实际事务、微信订阅模板和云存储规则的真机验证。
