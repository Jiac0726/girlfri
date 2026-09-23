# 热念 · CloudBase 数据恢复说明

数据库迁移前，`database-preflight.cmd` / `database-migrate.cmd` 会把以下集合完整导出到本机：

```text
backups/cloudbase/<时间戳>/raw/
├── couples/
├── couple_users/
└── ratings/
```

这些 JSON 文件属于业务数据备份，可能包含 OPENID、绑定关系和评价内容，已经被 `.gitignore` 排除，**不要提交到 GitHub，也不要发到公开渠道**。

## 优先恢复方式：CloudBase 时间点回档

CloudBase CLI 当前支持：

```text
tcb db nosql restore-time
tcb db nosql restore-tables
tcb db nosql restore
tcb db nosql restore-task
```

建议恢复到**新集合名**，确认数据正确后再人工切换，不要直接覆盖原集合。

示例流程：

```bat
tcb db nosql restore-time -e <ENV_ID>

tcb db nosql restore-tables ^
  --time "2026-09-23 10:30:00" ^
  --filters couples,couple_users,ratings ^
  -e <ENV_ID>

tcb db nosql restore ^
  --time "2026-09-23 10:30:00" ^
  --tables "[{\"OldTableName\":\"couples\",\"NewTableName\":\"couples_restored\"},{\"OldTableName\":\"couple_users\",\"NewTableName\":\"couple_users_restored\"},{\"OldTableName\":\"ratings\",\"NewTableName\":\"ratings_restored\"}]" ^
  -e <ENV_ID>

tcb db nosql restore-task -e <ENV_ID>
```

恢复完成后先核对数量和关键关系，再决定是否替换正式集合。

## 本地 JSON 备份

CloudBase 导出的 JSON 是 JSON Lines（每行一个完整 JSON 对象），可以在控制台的数据导入功能中重新导入。

建议：

1. 新建临时集合；
2. 以 Upsert / 按 `_id` 的方式导入备份；
3. 核对 `couples`、`couple_users` 和 `ratings` 的关联；
4. 确认无误后再处理正式集合。

## 迁移失败时

如果 `database-migrate.cmd` 中途停止：

- 不要删除它打印出的 **Pre-migration backup**；
- 不要继续手工批量修改数据；
- 保留 `PRECHECK.txt`、`preflight-report.json`、`migration-command.log`；
- 如果唯一索引创建失败，先修复报告中的 waiting 邀请码冲突，再重新执行预检。

索引本身不是数据备份的一部分。恢复数据后，仍需要重新确认：

```text
couples.idx_inviteCode_unique
ratings.idx_couple_date_ratedBy
```
