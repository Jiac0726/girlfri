# 热念 · 提审前检查清单

> 适用：`gf-rating` / `热念` / 微信小程序 + 云开发
> 依据：`wechat-miniprogram-cloudbase-{deploy,scaffold}` 的真实环境踩坑记录 + 本仓库实际状态核查
> 勾完再点「提交审核」。

---

## 🔴 P0 · 不做完必被驳回 / 功能等于没有

### 1. 三个页面不可达（**本仓库实测确认**）
`app.json` 的 `tabBar` 只有 `今天` / `回顾`，而下列页面**既不在 tabBar、也没有任何页面跳转到**：
- `pages/history/history`（历史记录）
- `pages/monthly/monthly`（月报）
- `pages/stats/stats`（成绩单）

全仓库 `wx.navigateTo` / `switchTab` / `redirectTo` 只指向 `/pages/bind/bind` 与 `/pages/index/index`。
**后果**：这三个功能用户点不到，审核员也点不到 → 要么当「页面不可访问」驳回，要么过了审等于没做。

- [ ] 在 `pages/review/review` 加三个入口（建议底部「更多」或卡片）
- [ ] 或把 `stats` 提为第三个 tab
- [ ] 自测：从冷启动开始，**每个页面**都能在 3 次点击内到达

### 2. 双人绑定 → 审核员单账号无法走通核心链路（**最高危驳回风险**）
核心功能是「两人用 8 位绑定码绑定后互评」。审核员通常只有**一个微信号**，无法完成绑定 → 核心功能全程不可体验。

- [ ] 提审备注里写明：「本小程序需两个微信账号互相绑定后使用」
- [ ] **强烈建议加一个「演示模式」**：未绑定时可查看只读示例数据（好评/差评/月报/成绩单各一条），让审核员能看全界面
- [ ] 或提供两个测试微信号 + 一对现成邀请码，写在「测试帐号」栏
- [ ] 版本描述里附 3 步上手指引（生成绑定码 → 另一号绑定 → 互评）

### 3. AppID / 云环境还是占位符
- [ ] `project.config.json` → `appid: "wxYOUR_APPID"` 换成真实 AppID
- [ ] `project.private.config.example.json` → 同上（复制成 `project.private.config.json`）
- [ ] 建 `config/env.local.js`（照 `config/env.local.example.js`），填 `cloudEnv`
- [ ] 跑 `setup-local.ps1` / `setup-local.cmd` 生成本机配置
- [ ] 确认 `config/env.js` 的 `configured === true`（否则前端不发请求）

### 4. ICP 备案（硬前置，周期长，**现在就启动**）
2023 年 9 月起小程序必须完成 ICP 备案才可上架。
- [ ] mp 后台 → 设置 → 基本设置 → ICP 备案 → 按指引提交
- [ ] 个人主体需实名 + 人脸核验；审核约 1~20 个工作日
- [ ] **备案没下来之前，后面所有步骤做了也发布不了**，请并行推进

---

## 🟠 P1 · 云开发侧（漏一个就「网络异常」）

### 5. 集合必须控制台手工建（CLI 建不了，坑 #1）
`tcb db create` 子命令已移除、通用 API 已离线、`db.add()` 不会隐式建集合且被静默吞掉。

- [ ] CloudBase 控制台 → 数据库 → 新建集合：
  - `couples`
  - `couple_users`（**注意不是 `users`**，`COLLECTIONS.users = 'couple_users'`）
  - `ratings`

### 6. 唯一索引（本仓库已为它改造过，别浪费）
P3B 修复后邀请码用完写 `USED_<pairId>` 而非 `null`，所以**普通唯一索引即可**，无需稀疏/过滤。
- [ ] `couples.inviteCode` → **唯一索引**
- [ ] `ratings.coupleId` + `date` → 普通索引（加速列表 + 配合 `orderBy`）

### 7. 云函数部署前必须装齐 `node_modules`（坑 #7）
`tcb fn deploy` 上传的是**本地目录**，Tencent SCF 不会云端自动装依赖。
- [ ] `cd cloudfunctions/renianApi && npm install`（装 `wx-server-sdk@4.0.2`，已锁版本 ✅）
- [ ] 确认 `node_modules/wx-server-sdk/` 真实存在后再 deploy

### 8. 相对 `require` 路径（坑 #6）
本仓库是单文件 `index.js`、无子目录 ✅ 当前无此风险。
- [ ] **但若以后拆 `services/` 子目录**：子文件里要用 `../db`、`./x`，不是 `./db`、`./services/x`
- [ ] 记住：`node --check` **只验语法不解析依赖**，路径错误查不出来，必须真机验

### 9. 部署后验证方式（坑 #2）
`tcb fn invoke` 报 `GetFunction Namespace取值与规范不符` 是**工具的 backend namespace bug**，不代表函数坏；反之它成功也不代表函数好 —— 它**没有真实 OPENID**。
- [ ] **端到端验证只认微信开发者工具 / 体验版真机**
- [ ] 体验版扫码 → 生成绑定码 → 第二个号绑定 → 互评 → 看历史/月报/成绩单

---

## 🟡 P2 · 上传与打包

### 10. `cloudfunctionRoot` 会让 CLI 顺带推云函数
`project.config.json` 现有 `cloudfunctionRoot: "cloudfunctions/"`。
- [ ] 若已用 `tcb` 部署好云函数，**上传纯前端时临时注释掉这一行**，避免重复推送覆盖
- [ ] 若用微信开发者工具上传，可保留

### 11. 上传 IP 白名单只收 IPv4（坑 #3）
IPv6 出口必被拒（`errCode: -10008 invalid ip: 2408:...`），且**白名单 UI 无法添加 IPv6**。
- [ ] 走 IPv6/代理出口时：**关掉 IP 白名单总开关**（一劳永逸，安全性由上传私钥兜底）
- [ ] 或切 IPv4 出口后 `curl -s https://ifconfig.me` 取 IP 加白名单（换网络要重加）
- [ ] 上传私钥 `.key` **只传文件路径、绝不把内容贴进对话/日志**
- [ ] 确认打包 `ignores` 含 `*.key`、`cloudfunctions/**`、`node_modules/**`（密钥与后端不进包）

### 12. 上传成功 ≠ 上线
- [ ] 明确：上传只产生**体验版**，真用户看不到
- [ ] 审核 + 发布是**纯人工步骤**，在 mp 后台操作

---

## 🟢 P3 · 提审材料

### 13. 类目（**千万别选「社交」**）
个人主体一级类目通常只有「生活服务 / 工具 / 体育」。「社交」要额外资质、审核严、**分享能力反而受限**。

- [ ] 首选：**生活服务 > 生活助手**
- [ ] 备选：**工具 > 记事本** / **工具 > 效率**
- [ ] 产品定位描述按「个人生活记录工具」写，**不要强调陌生人交友/社交**

### 14. 用户隐私保护指引
本仓库实测 **0 个隐私接口**（无 `getPhoneNumber` / `getUserInfo` / `getLocation` / `chooseImage` 等）。

- [ ] 未上线只能走**提审页面底部**的「用户隐私保护指引设置」（后台直填那个入口只对已发布生效）
- [ ] 勾最小项：**微信登录（openid）**（云函数 `getWXContext().OPENID` 用到）
- [ ] ⚠️ **勾少了接口失效、勾多了被驳回**，别顺手多勾
- [ ] 若审核要求补勾，按驳回意见逐项加，不要一次全上

### 15. 分享
- [ ] 分享给好友/群是**内置能力，无需申请** —— `pages/bind/bind.js` 已写 `onShareAppMessage` ✅
- [ ] 分享链接 `/pages/bind/bind?inviteCode=xxx&source=wechat_invite` ✅ 只带邀请码，不带 openid/pairId
- [ ] 若右上角 `···` 转发按钮灰掉：原因是**没做 ICP 备案 + 认证**，不是「没申请分享权限」
- [ ] 分享到朋友圈是另一回事（要 `onShareTimeline` + 受类目限制），**本项目不需要，别加**

### 16. 版本描述与测试说明
- [ ] 版本描述写清「双人绑定互评」的使用路径
- [ ] 测试帐号栏填两个测试微信号（或写明需要审核员自备两个号）
- [ ] 附一句：「未绑定时点击『生成绑定码』→ 另一微信扫码/输入绑定码 → 双方互评」

---

## ✅ 提审后

- [ ] 驳回时**按驳回意见逐条改**，别一次大改（大改要重新排队）
- [ ] 常见驳回：类目不符 / 隐私指引缺项 / **核心功能不可体验（见 P0-2）** / 页面不可达（见 P0-1）
- [ ] 通过后在 mp 后台点「发布」，全量可见
- [ ] 发布后去 CloudBase 看云函数调用日志，确认 `UNEXPECTED` 级别错误为 0（业务 `warn` 是正常的）

---

## 附：本仓库特有的安全基线（已完成，勿回退）

| 项 | 状态 |
|---|---|
| 身份来源 `cloud.getWXContext().OPENID`，不信任 `event` | ✅ |
| `requireActive()` 授权门禁 | ✅ |
| `cleanRating()` 输出脱敏，不泄露 `ratedBy`/`targetOpenid` | ✅ |
| P1/P2 TOCTOU（状态校验在事务内重读） | ✅ |
| P3B 邀请码用后写 `USED_<pairId>` | ✅ |
| P4 `listRatings` 稳定排序 | ✅ |
| P5 `safeGet` 只吞「文档不存在」 | ✅ |
| P6 `pair.join` 限流（内存桶，冷启动重置） | ✅ |
| 日志分级（预期业务错误走 warn） | ✅ |
| 依赖锁版本 `wx-server-sdk: 4.0.2` | ✅ |
| 回归测试 `node tests/renian-api/race.test.js` → 17/17 | ✅ |
