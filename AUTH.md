# 热念双人绑定与鉴权

## 目标

- 两个微信用户共享同一份关系记录。
- 「评价方」可以写每天的评价。
- 「查看方」只能读取，不能通过篡改前端请求写入。
- 数据库不再向小程序客户端开放读写。

## 身份来源

所有敏感操作都进入 `cloudfunctions/renianApi`。

云函数通过 `cloud.getWXContext().OPENID` 获取调用者身份，不接受前端传入的 openid 作为身份依据。

## 数据集合

### couples

保存一对关系和一次性绑定码。

关键字段：

- `status`: `waiting | active`
- `creatorOpenid`
- `creatorRole`
- `partnerOpenid`
- `memberOpenids`
- `inviteCode`
- `inviteExpiresAt`

### couple_users

以 OPENID 作为文档 `_id`，快速定位当前用户属于哪一对关系以及角色。

### ratings

每对关系每天一条：

```
_id = <coupleId>_<YYYY-MM-DD>
```

这样不同情侣不会因为同一天使用相同日期 `_id` 而冲突。

## 绑定流程

1. A 选择自己的角色并生成 8 位绑定码。
2. 云函数创建 `waiting` 关系，绑定码 24 小时有效。
3. B 输入绑定码。
4. 云函数在数据库事务中确认绑定码仍有效且 B 尚未绑定。
5. 关系变为 `active`，B 自动获得与 A 相反的角色。
6. 之后所有评价读写都按 `coupleId` 隔离。

## 数据库权限

正式使用时，`couples`、`couple_users`、`ratings` 都应禁止小程序客户端直接读写。

云函数在服务端访问数据库，并在每次操作前验证 OPENID、关系状态和角色。

## 现有旧数据

旧版 `ratings` 的 `_id` 只有日期，没有 `coupleId`。新鉴权版本不会自动读取这些旧记录，以避免错误归属。

如果已经有需要保留的真实旧数据，应在确认归属后做一次显式迁移，而不是自动认领。
