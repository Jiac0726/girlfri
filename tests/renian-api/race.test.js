#!/usr/bin/env node
// 云函数竞态回归测试（P1/P2 TOCTOU）
//
// 跑法：  node tests/renian-api/race.test.js [被测 index.js 路径]
// 默认测 cloudfunctions/renianApi/index.js。
//
// 背景：cancelInvite / refreshInvite 原先把 status 校验放在事务【外】，
// 存在 TOCTOU —— 发起人读到 waiting 之后、事务执行之前，对方恰好 joinPair
// 成功，旧代码会把一个已生效的 couple 删掉，且只删发起人的 couple_users，
// 给对方留下悬空 coupleId → 此后所有操作报 PAIR_NOT_FOUND，账号永久卡死。
// 本测试用 afterGet 钩子精确复现该窗口，并断言修复后的行为。
const path = require('path');
const Module = require('module');

// 把 'wx-server-sdk' 的解析重定向到本地 mock（无需安装依赖即可跑）
const mockPath = require.resolve('./mock-wx-server-sdk.js');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'wx-server-sdk') return mockPath;
  return origResolve.call(this, request, ...rest);
};

const sdk = require(mockPath);
const target = path.resolve(
  process.argv[2] || path.join(__dirname, '../../cloudfunctions/renianApi/index.js')
);
const colStore = sdk.__colStore;
const hooks = sdk.__hooks;
const results = [];

function record(name, pass, detail) {
  results.push({ name, pass });
  console.log(`   ${pass ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
}

function reset() {
  sdk.__reset();
  sdk.__setOpenid('OPENID_A');
}

const call = (action, data) => api.main(Object.assign({ action }, data || {}));

// 让「发起人读到 waiting」之后、「事务执行之前」对方恰好加入。
// 挂在 afterGet：第一次 couples.get 已把 waiting 快照交给调用方，
// 随后立刻把 store 篡改成 active —— 旧代码拿旧快照检查就会误放行。
function armRace() {
  let armed = true;
  hooks.afterGet = async (col, id) => {
    if (!armed || col !== 'couples') return;
    armed = false;
    const cs = colStore('couples');
    const pair = cs.get(id);
    if (!pair) return;
    cs.set(id, {
      ...pair,
      status: 'active',
      partnerOpenid: 'OPENID_B',
      memberOpenids: [pair.creatorOpenid, 'OPENID_B'],
      inviteCode: null,
    });
    colStore('couple_users').set('OPENID_B', {
      coupleId: id,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  };
}

let api;
async function main() {
  api = require(target);

  // ── T1｜正常取消（waiting）应成功并清理 ────────────────────
  console.log('\n[T1] 正常取消未完成邀请');
  reset();
  await call('pair.create');
  const pid1 = [...colStore('couples').keys()][0];
  const r1 = await call('pair.cancel');
  record('waiting 状态下取消成功', r1.ok === true && !colStore('couples').has(pid1));
  record('发起人 couple_users 已清理', !colStore('couple_users').has('OPENID_A'));

  // ── T2｜★ P1：取消与加入竞态 ─────────────────────────────
  console.log('\n[T2] ★ P1 —— 取消与加入竞态（对方恰在此刻 joinPair）');
  reset();
  await call('pair.create');
  const pid2 = [...colStore('couples').keys()][0];
  armRace();
  let r2;
  let r2err = null;
  try {
    r2 = await call('pair.cancel');
  } catch (e) {
    r2err = e;
  }
  record(
    '拒绝取消（而不是静默删掉）',
    !!r2err || (r2 && r2.ok === false),
    r2err ? `抛出 ${r2err.code}` : r2 && r2.ok === false ? `返回 ${r2.error.code}` : '未拒绝 ⚠️'
  );
  record(
    'active 的 couple 仍然存在',
    colStore('couples').has(pid2),
    colStore('couples').has(pid2) ? '保住' : '已被删除 —— 绑定关系被销毁'
  );

  // 上一条若只查 couple_users.coupleId === pid2 是弱断言（couple 被删后仍为真）。
  // 真症状是对方此后任何操作都报 PAIR_NOT_FOUND 且无法自行解绑 —— 端到端验。
  sdk.__setOpenid('OPENID_B');
  let bOk = true;
  let bErr = '';
  try {
    const rb = await call('rating.today');
    bOk = !!(rb && rb.ok === true);
    if (!bOk) bErr = (rb && rb.error && rb.error.code) || 'ok=false';
  } catch (e) {
    bOk = false;
    bErr = e.code || e.message;
  }
  sdk.__setOpenid('OPENID_A');
  record(
    '对方未被锁死（端到端调用 rating.today）',
    bOk,
    bOk ? '账号仍可用' : bErr + ' → 账号永久卡死'
  );

  // ── T3｜P2：刷新邀请码与加入竞态 ─────────────────────────
  console.log('\n[T3] P2 —— 刷新邀请码与加入竞态');
  reset();
  await call('pair.create');
  const pid3 = [...colStore('couples').keys()][0];
  armRace();
  let r3;
  let r3err = null;
  try {
    r3 = await call('pair.refresh');
  } catch (e) {
    r3err = e;
  }
  record(
    '拒绝刷新',
    !!r3err || (r3 && r3.ok === false),
    r3err ? `抛出 ${r3err.code}` : (r3 && r3.error && r3.error.code) || '未拒绝 ⚠️'
  );
  record(
    "active pair 的 inviteCode 仍为空",
    colStore('couples').get(pid3).inviteCode === null,
    colStore('couples').get(pid3).inviteCode === null
      ? '未被污染'
      : '被写入 ' + colStore('couples').get(pid3).inviteCode
  );

  // ── T4｜回归：正常绑定 + 互评链路 ─────────────────────────
  console.log('\n[T4] 回归 —— 正常绑定与评分链路');
  reset();
  await call('pair.create');
  const code = colStore('couples').get([...colStore('couples').keys()][0]).inviteCode;
  sdk.__setOpenid('OPENID_B');
  const r4 = await call('pair.join', { inviteCode: code });
  record('对方用邀请码绑定成功', r4.ok === true && r4.data.bound === true);
  const r5 = await call('rating.save', { type: 'good', reason: '测试' });
  record('绑定后可正常评分', r5.ok === true && r5.data.rating.type === 'good');
  const r6 = await call('rating.save', { type: 'bad', reason: 'x' });
  record('同日二次评分 = 覆盖（一天一条）', r6.ok === true);
  sdk.__setOpenid('OPENID_A');
  const r7 = await call('rating.today');
  const pr = (r7 && r7.data && r7.data.partnerRating) || {};
  record(
    '互评可见且不泄露身份字段',
    r7.ok === true &&
      r7.data.partnerRating &&
      pr.ratedBy === undefined &&
      pr.targetOpenid === undefined,
    '输出字段: ' + Object.keys(pr).join(',')
  );
  // 【P3·方案 B】绑定后 inviteCode 应改写成 USED_<pairId>（而非 null），
  // 这样 couples.inviteCode 可直接建普通唯一索引兕底。
  const usedCode = colStore('couples').get([...colStore('couples').keys()][0]).inviteCode;
  record(
    'P3B 邀请码用后改写为 USED_<pairId>',
    typeof usedCode === 'string' && usedCode.indexOf('USED_') === 0,
    String(usedCode)
  );
  // 【P4】多条记录下分页应完整取回、无漏行重行（mock 的 orderBy 已真排序）
  for (let i = 0; i < 5; i += 1) {
    colStore('ratings').set('TESTPAD_' + i, {
      coupleId: [...colStore('couples').keys()][0],
      date: '2026-01-0' + (i + 1),
      type: 'good',
      reason: 'pad' + i,
      ratedBy: 'OPENID_PAD',
      targetOpenid: 'OPENID_A',
      updatedAt: new Date(),
    });
  }
  const r8 = await call('rating.list');
  const ids = (r8.data || []).map((x) => x.date + ':' + (x.fromMe ? 'me' : 'ta'));
  record(
    'P4 分页取回完整无漏行/重行',
    r8.ok === true && new Set(ids).size === ids.length && ids.length >= 6,
    '条数 ' + ids.length + ' 去重后 ' + new Set(ids).size
  );

  // ── T5｜P6：pair.join 限流 ────────────────────────────
  console.log('\n[T5] P6 —— pair.join 尝试限流');
  sdk.__setOpenid('OPENID_C');
  let throttleCode = '';
  let attempts = 0;
  for (let i = 0; i < 12; i += 1) {
    attempts += 1;
    const rt = await call('pair.join', { inviteCode: 'ZZZZZZZZ' });
    if (rt && rt.ok === false) {
      throttleCode = rt.error.code;
      if (throttleCode === 'TOO_MANY_ATTEMPTS') break;
    }
  }
  record(
    '超出上限后被限流',
    throttleCode === 'TOO_MANY_ATTEMPTS',
    '第 ' + attempts + ' 次 → ' + throttleCode
  );

  // ── T6｜P5：瞬时故障不应伪装成「未绑定」 ─────────────────
  console.log('\n[T6] P5 —— 数据库瞬时故障的错误语义');
  reset();
  await call('pair.create');
  sdk.__setOpenid('OPENID_B');
  hooks.beforeGet = () => {
    const e = new Error('db unavailable');
    e.errCode = -1000;
    throw e;
  };
  const r9 = await call('rating.today');
  delete hooks.beforeGet;
  sdk.__setOpenid('OPENID_A');
  record(
    '报 INTERNAL 而非 NOT_BOUND',
    r9 && r9.ok === false && r9.error.code === 'INTERNAL',
    r9 && r9.ok === false ? '返回 ' + r9.error.code : '未失败'
  );

  // ── T7｜日志分级：预期业务错误不应污染 error 日志 ─────────
  console.log('\n[T7] 日志分级 —— 预期业务错误不打 error');
  reset();
  const logs = { warn: [], error: [] };
  const origWarn = console.warn;
  const origErr = console.error;
  console.warn = (...a) => logs.warn.push(a.map(String).join(' '));
  console.error = (...a) => logs.error.push(a.map(String).join(' '));

  // 预期业务错误：未绑定用户调 rating.today → NOT_BOUND (ApiError)
  sdk.__setOpenid('OPENID_NOBODY');
  await call('rating.today');
  const warnN = logs.warn.length;
  const errN = logs.error.length;

  // 未预期异常：让 get 抛非 notFound 类错误 → 应走 error
  hooks.beforeGet = () => {
    const e = new Error('boom');
    e.errCode = -2000;
    throw e;
  };
  await call('rating.today');
  delete hooks.beforeGet;

  console.warn = origWarn;
  console.error = origErr;
  sdk.__setOpenid('OPENID_A');

  record(
    '预期业务错误只走 warn（error 计数不变）',
    warnN >= 1 && errN === 0,
    'warn=' + warnN + ' error=' + errN
  );
  record(
    '未预期异常才走 error',
    logs.error.length >= 1,
    'error=' + logs.error.length
  );

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n══════ ${passed}/${results.length} 通过 ══════`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error('测试驱动异常:', e);
  process.exit(2);
});
