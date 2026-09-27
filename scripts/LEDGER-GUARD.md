# 变更台账维护守卫

本目录下的 `check-ledger.js` 是一个**提交前守卫**：

**改动产品代码时，必须同步更新 [`docs/变更台账.md`](../docs/变更台账.md)。**

## 为什么

`docs/变更台账.md` 记录「改了什么、为什么改、怎么验证的、有什么局限」。
没有它，代码改了但动机和验证基线无从追溯；出了问题也说不清是哪次改动引入的。

## 规则

| 改动内容 | 是否要求更新台账 |
|---|---|
| `app.*` `pages/**` `cloudfunctions/**` `services/**` `config/**` `scripts/**` 等产品代码 | ✅ **必须** |
| 仅 `docs/**` `tests/**` `.github/**` `assets/**` `*.md` | ❌ 不要求 |
| 无改动 | ❌ 不要求 |

## 本地跑

```bash
node scripts/check-ledger.js                 # 自动对比 origin/main
node scripts/check-ledger.js <base> <head>   # 显式指定
```

退出码 0 = 通过，1 = 拒绝（附带触发规则的文件清单）。

## CI

由 `.github/workflows/renian-checks.yml` 的 `ledger-guard` job 调用。
该 job 与 `node-tests`、`powershell-parse` 并列，任一失败即整体失败。

## 台账条目该写什么

见 `docs/变更台账.md` 的「八、台账维护规则」。要点：

- 必须带 **commit SHA**（可追溯）
- **验证必须写基线数字**（如 `17/17`），不写「测试通过」
- **局限与已知缺陷必须写进条目**，不藏在别处
- **总数类数字带快照时点**，不做永久承诺
- 不覆盖历史条目；已被取代的变更在「六」单列
