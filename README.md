# 热念 💕

> 把每天的喜欢、在意和小情绪认真留下来。
> 两个人绑定后，双方每天都可以各评价对方一次，也都能查看共同记录。

## 当前功能

| 页面 | 作用 |
|---|---|
| **今日评价** | 我每天可以给 TA 写一条好评 / 差评；TA 也可以独立给我写一条 |
| **历史记录** | 区分「我给 TA」和「TA 给我」，查看全部双向记录 |
| **月报** | 双向月历、双方评价好评率、高光 / 翻车 / 小作文 |
| **成绩单** | 双方好评率、双方连续好评、14 天双向状态、导出图片 |
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
├── services/
│   └── cloud.js
├── cloudfunctions/
│   └── renianApi/
│       ├── index.js
│       └── package.json
├── pages/
│   ├── index/
│   ├── history/
│   ├── monthly/
│   ├── stats/
│   └── bind/
├── AUTH.md
├── BRAND.md
└── project.config.json
```

---

## 部署

### 1. 配置云环境

`app.js`：

```js
wx.cloud.init({
  env: '你的环境ID',
  traceUser: true,
});
```

`project.config.json`：

```json
"appid": "你的AppID"
```

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
