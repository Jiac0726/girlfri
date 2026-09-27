#!/usr/bin/env node
/**
 * 台账守卫 —— 代码改了就必须同步更新 docs/变更台账.md
 *
 * 规则（见台账「八、台账维护规则」）：
 *   改动 pages/ cloudfunctions/ services/ config/ scripts/ app.* project.config.json
 *   等「产品代码」时，必须同时改动 docs/变更台账.md，否则拒绝。
 *   仅改 docs/ tests/ .github/ assets/ 等文档与测试时，不要求。
 *
 * 用法：
 *   node scripts/check-ledger.js              # 自动判定基线
 *   node scripts/check-ledger.js <base> <head> # 显式指定
 *
 * 在 CI 中由 .github/workflows/renian-checks.yml 调用。
 */
const { execSync } = require('child_process');

const LEDGER = 'docs/变更台账.md';

// 需要记台账的改动路径
const CODE_PATHS = [
  /^app\.(js|json|wxss)$/,
  /^pages\//,
  /^cloudfunctions\//,
  /^services\//,
  /^config\//,
  /^scripts\//,
  /^project\.config\.json$/,
  /^project\.private\.config\.example\.json$/,
  /^sitemap\.json$/,
  /^cloudbaserc\.json$/,
  /^database-.*\.(ps1|cmd)$/,
  /^v2-migrate-legacy\.(ps1|cmd)$/,
  /^setup-local\.(ps1|cmd)$/,
  /^update-main.*\.(ps1|cmd)$/,
];

// 不要求记台账的改动路径（文档、测试、CI、资源）
// 注：\.md$ 放在最前，保证任意目录下的 Markdown 都算文档（含 scripts/LEDGER-GUARD.md）
const DOC_PATHS = [
  /\.md$/i,
  /^docs\//,
  /^tests\//,
  /^\.github\//,
  /^assets\//,
  /^\.gitignore$/,
  /^LICENSE/,
];

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) {
    return '';
  }
}

/**
 * 结构自检：每个「### 变更 #N」条目都必须有「修改人」署名。
 * 署名取自 git author，合并类条目必须分开写「实施」与「整合 / 记录」。
 */
function checkAttribution() {
  const fs = require('fs');
  if (!fs.existsSync(LEDGER)) return null;
  const text = fs.readFileSync(LEDGER, 'utf8');
  const entries = (text.match(/^### 变更 #\d+/gm) || []).length;
  const signed = (text.match(/\| \*\*修改人\*\* \|/g) || []).length;
  return { entries, signed, ok: entries > 0 && signed >= entries };
}

function resolveRange() {
  const a = process.argv[2];
  const b = process.argv[3] || 'HEAD';
  if (a) return [a, b];

  // GitHub PR：对比目标分支
  if (process.env.GITHUB_BASE_REF) {
    return [`origin/${process.env.GITHUB_BASE_REF}`, 'HEAD'];
  }
  // GitHub push：对比推送前的提交
  const before = process.env.GITHUB_EVENT_BEFORE;
  if (before && !/^0+$/.test(before) && sh(`git cat-file -e ${before}`) === '') {
    return [before, 'HEAD'];
  }
  // 本地：对比 main 的分叉点
  return ['origin/main...HEAD', null];
}

function classify(files) {
  const code = [];
  const doc = [];
  const other = [];
  for (const f of files) {
    if (f === LEDGER) continue;
    // ⚠️ 顺序敏感：文档规则先于代码规则。
    // 否则 scripts/LEDGER-GUARD.md 会被 /^scripts\// 误判成产品代码。
    if (DOC_PATHS.some((r) => r.test(f))) doc.push(f);
    else if (CODE_PATHS.some((r) => r.test(f))) code.push(f);
    else other.push(f);
  }
  return { code, doc, other };
}

function main() {
  const [base, head] = resolveRange();
  const range = head ? `${base}...${head}` : base;
  // ⚠️ 必须用 -z（NUL 分隔）。默认输出会把非 ASCII 文件名转义成
  // 八进制带引号串（"docs/\345\217\230..."），导致 includes(LEDGER)
  // 永远匹配不上 —— 守卫会对中国文件名静默失效。
  const raw = sh(`git diff --name-only -z --diff-filter=ACMRD ${range}`);
  const files = raw ? raw.split('\0').filter(Boolean) : [];

  if (files.length === 0) {
    console.log(`[ledger-guard] 无改动文件（range: ${range}）→ 通过`);
    return 0;
  }

  const { code, doc, other } = classify(files);
  const ledgerChanged = files.includes(LEDGER);

  console.log(`[ledger-guard] 比较范围: ${range}`);
  console.log(`[ledger-guard] 改动文件 ${files.length} 个 = 代码 ${code.length} · 文档 ${doc.length} · 其他 ${other.length}`);
  console.log(`[ledger-guard] 台账是否更新: ${ledgerChanged ? '是' : '否'}`);

  if (code.length === 0) {
    console.log('[ledger-guard] ✅ 未触及产品代码，不要求更新台账');
    return 0;
  }

  if (ledgerChanged) {
    const attr = checkAttribution();
    if (attr && !attr.ok) {
      console.error('\n[ledger-guard] ❌ 拒绝：台账条目缺少「修改人」署名');
      console.error(`  变更条目 ${attr.entries} 个，带署名 ${attr.signed} 个`);
      console.error('  每条都要有 `| **修改人** | ... |`：');
      console.error('    - 直接提交 → 写 git 的提交作者（名字 <邮箱>）');
      console.error('    - 合并类  → 双署名：**实施** = 被合入提交作者；**整合 / 记录** = 做合并的人');
      console.error('  规则见台账「八、台账维护规则」第 7 条。\n');
      return 1;
    }
    console.log('[ledger-guard] ✅ 产品代码有改动且台账已同步' +
      (attr ? `（署名 ${attr.signed}/${attr.entries}）` : ''));
    return 0;
  }

  console.error('\n[ledger-guard] ❌ 拒绝：改动了产品代码但没有更新变更台账');
  console.error('\n  触发规则的文件：');
  code.slice(0, 20).forEach((f) => console.error(`    - ${f}`));
  if (code.length > 20) console.error(`    … 另有 ${code.length - 20} 个`);
  console.error('\n  请在 docs/变更台账.md 追加一条记录，格式见该文件「二、代码变更明细」：');
  console.error('    日期 · commit · 类别 · 标题 · 动机 · 改动内容 · 涉及文件 · 验证方式 · 局限 · 状态');
  console.error('  并在「八、台账维护规则」的约定下保持字段完整（验证要写基线数字）。\n');
  return 1;
}

process.exit(main());
