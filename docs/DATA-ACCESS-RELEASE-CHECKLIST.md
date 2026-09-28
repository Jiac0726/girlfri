# 热念 · 数据库与云存储上线权限清单

更新时间：2026-09-28

## 一、目标权限模型

小程序客户端不直接访问文档数据库。所有业务读写均通过 `renianApi` 完成。

因此生产环境 V2 集合应全部设置为“无权限”：
- 客户端读：禁止
- 客户端写：禁止
- 云函数 / 服务端 SDK：继续可访问

CloudBase 官方将“无权限”用于需要服务端处理的敏感数据场景。

## 二、生产数据库必须逐项确认

以下 12 个集合均应为“无权限”：

- `v2_users`
- `v2_couples`
- `v2_invites`
- `v2_entries`
- `v2_agreements`
- `v2_coupons`
- `v2_coupon_requests`
- `v2_media`
- `v2_operations`
- `v2_albums`
- `v2_album_photos`
- `v2_album_comments`

对应仓库来源：
- `config/database.v2.json`
- `config/database.albums.json`

发布脚本 `scripts/release-cloudbase-apply.ps1` 会读取这两份 manifest，并通过 CloudBase `ModifyDatabaseACL` API 将所有正式集合设置为 `ADMINONLY`（控制台“所有用户不可读写”）；随后 `scripts/release-cloudbase-audit.ps1` 使用 `DescribeDatabaseACL` 逐项读回验证。

## 三、遗留集合

旧库集合 `couples`、`couple_users`、`ratings` 仅供历史迁移/备份使用，不应由当前小程序客户端直接访问。

若这些集合仍保留在生产环境：
- 发布脚本会自动将它们设置为 `ADMINONLY`；若集合已不存在则跳过。
- 不要删除，直到最终备份与回滚快照完成。
- 当前正式发布配置不部署 `legacyV2Migration`，不要重新执行旧迁移。

## 四、云存储生产规则

当前发布规则：

```json
{
  "read": "false",
  "write": "auth != null && (/^v2-upload\\//.test(resource.path) || /^v2-review\\//.test(resource.path))"
}
```

含义：
- 客户端直接读取：禁止。
- 未登录请求写入：禁止。
- 已登录用户仅可写 `v2-upload/` 与 `v2-review/` staging 目录。
- `v2-published/` 不允许客户端直接写。
- 正式图片通过服务端确认、内容安全检查后发布；读取通过服务端返回的临时签名 URL。

### 已知剩余风险

因为当前 CloudBase staging 上传采用客户端 `wx.cloud.uploadFile`，而服务端预登记后的文件无法继续依赖 `resource.openid == auth.openid` 完成写入，所以 staging 规则按“已登录 + 路径白名单”放行。

这意味着已登录的小程序用户理论上可以绕过页面，自行向两个 staging 前缀上传未登记文件。业务层不会引用这类文件，但它可能形成存储滥用。

当前缓解措施：
- staging 前缀不可读取；
- 正式目录不可由客户端写；
- 正式发布必须匹配服务端生成的 media 记录与 fileID；
- 原图服务端限制 20 MB；
- 审核副本服务端限制 1 MB；
- 已登记的废弃媒体由清理任务处理。

后续若要进一步收紧，可改为“服务端签发一次性上传凭证 + 客户端直传 COS”，然后把 CloudBase 客户端 storage write 关闭。

## 五、代码侧自动守卫

CI 必须保证：
1. 两份数据库 manifest 的所有集合均保持 `read=false / write=false`；
2. 小程序 `pages/`、`services/`、`helpers/` 与 `app.js` 不出现 `wx.cloud.database()`；
3. 云存储规则保持客户端 read=false，且正式发布目录不开放客户端写入。

## 六、生产验收

推荐直接运行：

```powershell
.\scripts\release-cloudbase-apply.ps1 -EnvId cloud1-d1gw3jjv3de5cd7b1
```

脚本会自动：
1. 部署并校验正式云函数；
2. 将 12 个 V2 集合设为 `ADMINONLY`；
3. 对仍存在的 `couple_users`、`couples`、`ratings` 也设为 `ADMINONLY`；
4. 运行只读 audit，再通过 `DescribeDatabaseACL` 逐项确认权限；
5. 任一正式集合不是 `ADMINONLY` 时直接失败，不继续把它当作发布成功。

如只想检查而不修改，运行：

```powershell
.\scripts\release-cloudbase-audit.ps1 -EnvId cloud1-d1gw3jjv3de5cd7b1
```

数据库 ACL 自动化后，仍需保留云存储第 4 节的自定义规则，并做一次真机验证：日常文字、图片上传/显示、相册评论、私密备忘录均正常。

全部通过后，第 5 项“数据库 + 云存储最终权限审计”才算完成。
