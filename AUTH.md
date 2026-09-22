# 热念双人绑定与鉴权

## 核心原则

热念的关系是**双向、对等**的，不存在固定“评价方 / 查看方”。

绑定后的 A 与 B 都可以：

- 每天评价对方一次；
- 查看对方给自己的评价；
- 查看双方共同历史、月报和成绩单。

因此一对关系一天最多产生 **2 条评价**：

- A → B 一条；
- B → A 一条。

双方的评价互相独立，任何一方更新自己当天的评价，都不会覆盖另一方。

## 身份来源

所有敏感操作都进入：

```
cloudfunctions/renianApi
```

云函数通过：

```js
cloud.getWXContext().OPENID
```

获取真实调用者身份，不接受前端传入的 OPENID 作为身份依据。

## 数据集合

### couples

保存一对关系和一次性绑定码。

关键字段：

- `status`: `waiting | active`
- `creatorOpenid`
- `partnerOpenid`
- `memberOpenids`
- `inviteCode`
- `inviteExpiresAt`

### couple_users

以 OPENID 作为文档 `_id`，用于快速定位该用户属于哪一对关系。

不保存固定评价角色。

### ratings

每条评价都保存方向：

- `ratedBy`: 谁写的；
- `targetOpenid`: 写给谁。

同一成员每天只有一条自己的评价，文档 ID：

```
<coupleId>_<YYYY-MM-DD>_<authorHash>
```

其中 `authorHash` 是评价人 OPENID 的 SHA-256 截断值，不直接把 OPENID 放进文档 ID。

这样：

- A 和 B 同一天可以各写一条；
- A 重复提交只覆盖 A 自己当天的评价；
- B 的评价不会被 A 覆盖；
- 不同情侣之间也不会冲突。

## 绑定流程

1. A 生成 8 位绑定码；
2. 云函数创建 `waiting` 关系，绑定码 24 小时有效；
3. B 输入绑定码；
4. 云函数在数据库事务中检查绑定码仍有效、B 尚未绑定；
5. 关系变为 `active`；
6. A、B 成为完全对等的两个成员；
7. 后续所有数据按 `coupleId` 隔离。

## 统计口径

因为现在一天可能有两条评价：

- 好评率：按双方所有评价条数计算；
- 日历：左侧表示“我给 TA”，右侧表示“TA 给我”；
- “双方连续好评”：只有当天两个人都提交评价，并且两条都是好评，才记为连续好评 1 天。

## 数据库权限

正式使用时：

- `couples`
- `couple_users`
- `ratings`

都应禁止小程序客户端直接读写。

云函数在服务端访问数据库，并在每次操作前验证 OPENID 和 `coupleId` 成员关系。

## 旧版数据

最初版本的 `ratings._id` 只有日期，也没有 `coupleId / ratedBy / targetOpenid`。

这些记录无法可靠判断“属于哪一对、是谁评价谁”，因此新版本不会自动认领。需要保留时应人工确认归属后显式迁移。
