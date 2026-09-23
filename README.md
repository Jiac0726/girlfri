# 热念 💕

> 把每天的喜欢、在意和小情绪认真留下来。
> 两个人绑定后，双方每天都可以各评价对方一次，也都能查看共同记录。

## 当前功能

| 页面 | 作用 |
|---|---|
| **今日评价** | 我每天可以给 TA 写一条好评 / 差评；TA 也可以独立给我写一条 |
| **回顾** | 合并历史、月报和成绩单：双方好评率、双向月历、高光 / 小摩擦、历史记录、生成回顾卡片 |
| **双人绑定** | 微信好友邀请卡片 + 8 位备用绑定码，建立两人的对等共享关系 |

## 双向模型

热念没有固定的“评价方 / 查看方”。

一对关系一天最多有两条评价：

```
A -> B
B -> A
```

两条互相独立。

A 更新自己今天的评价时，只覆盖 A→B；不会覆盖 B→A。

---

## 安全模型

客户端不直接读写云数据库。

所有绑定和评价操作统一进入：

```
cloudfunctions/renianApi
```

云函数使用 `cloud.getWXContext().OPENID` 获取真实调用者身份，并在服务端检查用户是否属于当前 `coupleId`。

即使修改前端 JS，也不能把自己伪装成绑定关系之外的用户。

---

## 目录结构

```
renian/
├── app.js
├── app.json
├── app.wxss
├── config/
│   ├── env.js
│   └── env.local.js            # 本机云环境 ID，不入 Git
├── project.private.config.json # 本机 AppID，不入 Git
├── setup-local.cmd             # 首次本机配置/迁移
├── update-main.cmd             # 安全更新
├── update-main-force.cmd       # 强制同步远程 main
├── database-preflight.cmd      # 只读备份 + 数据审计
├── database-migrate.cmd        # 明确确认后执行迁移/建索引
├── scripts/
│   └── database-common.ps1
├── services/
│   └── cloud.js
├── cloudfunctions/
│   └── renianApi/
│       ├── index.js
│       └── package.json
├── pages/
│   ├── index/
│   ├── review/                  # 主回顾页：统计 + 月历 + 故事 + 历史
│   └── bind/
├── AUTH.md
├── BRAND.md
└── project.config.json
```

---

## 部署

### 1. 首次配置本机环境

本机 AppID 和云环境 ID 不再直接写入受 Git 管理的代码文件。

首次更新到这一版后，运行：

```text
setup-local.cmd
```

脚本会生成：

```text
project.private.config.json
config/env.local.js
```

两个文件都被 Git 忽略，因此后续更新不会覆盖本机配置。

如果你是从旧版迁移，可先备份：

```bat
copy app.js app.local.bak.js
copy project.config.json project.config.local.bak.json
```

新版 `setup-local.cmd` 会自动从这些备份中识别已有 AppID / 云环境 ID。

### 1.1 更新代码

安全更新：

```text
update-main.cmd
```

如果本地改过受 Git 跟踪的代码，它会停止。

明确以远程 `main` 为准、丢弃本地代码修改时：

```text
update-main-force.cmd
```

强制更新只重置 Git 跟踪文件，不会删除 `project.private.config.json` 和 `config/env.local.js`。

### 1.2 数据库预检与索引迁移

数据库维护拆成两个阶段，**先只读预检，再明确执行迁移**。

首次使用前需要：

```text
npm i -g @cloudbase/cli
tcb login
```

第一步运行：

```text
database-preflight.cmd
```

它只做以下事情，不修改云数据库：

1. 全量导出 `couples`、`couple_users`、`ratings`；
2. 保存到 `backups/cloudbase/<时间戳>/raw/`；
3. 直接读取导出的 JSON Lines 做本地数据审计；
4. 检查 waiting 邀请码是否合法、是否重复；
5. 列出所有需要规范化为 `USED_<pairId>` 的非 waiting 关系；
6. 检查评价记录是否缺少 `coupleId/date/ratedBy`；
7. 输出 `PRECHECK.txt` 和 `preflight-report.json`。

只有看到：

```text
SAFE TO MIGRATE: True
```

才进入第二步：

```text
database-migrate.cmd
```

迁移脚本会**重新做一次最新全量备份和预检**，然后要求手工输入：

```text
MIGRATE
```

才会写库。写入规则为：

- `status == waiting`：保留合法 8 位邀请码；
- 所有非 `waiting` 关系：统一规范为 `USED_<pairId>`；
- 每条旧数据按具体 `_id` 精确更新，并再次要求 `status != waiting`，避免误改正在变化的邀请。

随后创建：

```text
couples
  idx_inviteCode_unique
  UNIQUE
  inviteCode ASC

ratings
  idx_couple_date_ratedBy
  NON-UNIQUE
  coupleId ASC
  date DESC
  ratedBy ASC
```

迁移完成后会再生成一份 post-flight 全量备份和审计报告。

备份目录已经加入 `.gitignore`，因为其中可能包含 OPENID、绑定关系和评价内容，不应提交到 GitHub。恢复说明见 `docs/DATABASE-RECOVERY.md`。

### 2. 创建集合

在云开发数据库创建：

```
couples
couple_users
ratings
```

### 3. 关闭客户端数据库直读写

正式使用时，这三个集合不要设置成：

```json
{ "read": true, "write": true }
```

客户端只调用 `renianApi`，数据库由云函数在服务端访问。

### 4. 部署云函数

微信开发者工具中找到：

```
cloudfunctions/renianApi
```

选择：

**上传并部署：云端安装依赖（不上传 node_modules）**

### 5. 双人绑定

第一位：

1. 打开「双人绑定」；
2. 点击「创建微信邀请」；
3. 点击「微信邀请 TA」，把小程序卡片发给对方。

第二位：

1. 在微信里点开邀请卡片；
2. 小程序自动带入一次性绑定码；
3. 点击「接受邀请并绑定」。

仍保留 8 位绑定码作为备用方案。绑定码有效期 **24 小时**，使用后失效。

绑定后双方权限相同：都可以评价对方，也都可以查看双方记录。

---

## 数据结构

### couples

```json
{
  "_id": "pair_xxx",
  "status": "active",
  "creatorOpenid": "...",
  "partnerOpenid": "...",
  "memberOpenids": ["...", "..."]
}
```

### couple_users

```json
{
  "_id": "<OPENID>",
  "coupleId": "pair_xxx",
  "status": "active"
}
```

### ratings

每条评价：

```json
{
  "coupleId": "pair_xxx",
  "date": "2026-09-22",
  "type": "good",
  "reason": "今天主动做了饭还洗了碗",
  "ratedBy": "<评价人的 OPENID>",
  "targetOpenid": "<被评价人的 OPENID>",
  "updatedAt": "<时间>"
}
```

文档 ID：

```
<coupleId>_<YYYY-MM-DD>_<authorHash>
```

因此同一对情侣每天最多两条，双方互不覆盖。

---

## 统计口径

- **双方好评率**：双方所有评价中，好评条数 / 总评价条数。
- **双向日历**：左边是“我给 TA”，右边是“TA 给我”。
- **双方连续好评**：同一天两个人都评价且两条均为好评，才算 1 天。

---

## 旧数据

最早版本的 `ratings` 只有日期，没有关系 ID，也没有评价方向。

新版不会自动归属旧记录，以免把历史数据认错人。需要保留时应单独迁移。

详细设计见 [AUTH.md](./AUTH.md)。
