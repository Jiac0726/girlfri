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

function duplicateWriteError() {
  const e = new Error(
    'DATABASE_DUPLICATE_WRITE E11000 duplicate key index: idx_inviteCode_unique'
  );
  e.code = 'DATABASE_DUPLICATE_WRITE';
  return e;
}

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


  // ── T8｜邀请码唯一索引：pair.create 撞码自动重试 ───────────
  console.log('\n[T8] 唯一索引 —— pair.create 撞码自动重试');
  reset();
  const createCodes = [];
  let createInjected = false;
  hooks.beforeSet = async (col, id, data) => {
    if (col !== 'couples') return;
    createCodes.push(data.inviteCode);
    if (!createInjected) {
      createInjected = true;
      throw duplicateWriteError();
    }
  };

  const r10 = await call('pair.create');
  delete hooks.beforeSet;

  record(
    '首次 duplicate write 后自动重试并创建成功',
    r10 &&
      r10.ok === true &&
      r10.data &&
      r10.data.bindingStatus === 'waiting' &&
      createCodes.length >= 2,
    'couples.set 尝试 ' + createCodes.length + ' 次'
  );
  record(
    '失败事务已回滚，只留下一个 pair / user',
    colStore('couples').size === 1 && colStore('couple_users').size === 1,
    'couples=' +
      colStore('couples').size +
      ' users=' +
      colStore('couple_users').size
  );

  // ── T9｜邀请码唯一索引：pair.refresh 撞码自动重试 ──────────
  console.log('\n[T9] 唯一索引 —— pair.refresh 撞码自动重试');
  const refreshPairId = [...colStore('couples').keys()][0];
  const beforeRefreshCode = colStore('couples').get(refreshPairId).inviteCode;
  let refreshAttempts = 0;
  hooks.beforeUpdate = async (col, id, data) => {
    if (
      col === 'couples' &&
      id === refreshPairId &&
      Object.prototype.hasOwnProperty.call(data, 'inviteCode')
    ) {
      refreshAttempts += 1;
      if (refreshAttempts === 1) throw duplicateWriteError();
    }
  };

  const r11 = await call('pair.refresh');
  delete hooks.beforeUpdate;

  const afterRefreshCode = colStore('couples').get(refreshPairId).inviteCode;
  record(
    'refresh 首次 duplicate write 后自动重试成功',
    r11 &&
      r11.ok === true &&
      r11.data &&
      r11.data.bindingStatus === 'waiting' &&
      refreshAttempts >= 2,
    'update 尝试 ' + refreshAttempts + ' 次'
  );
  record(
    'refresh 最终写入新的合法 8 位邀请码',
    typeof afterRefreshCode === 'string' &&
      /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(afterRefreshCode) &&
      afterRefreshCode !== beforeRefreshCode,
    beforeRefreshCode + ' -> ' + afterRefreshCode
  );

  // ── T10｜连续撞唯一索引：达到上限后明确失败且无脏数据 ─────
  console.log('\n[T10] 唯一索引 —— 连续撞码达到重试上限');
  reset();
  let exhaustedAttempts = 0;
  hooks.beforeSet = async (col) => {
    if (col !== 'couples') return;
    exhaustedAttempts += 1;
    throw duplicateWriteError();
  };

  const r12 = await call('pair.create');
  delete hooks.beforeSet;

  record(
    '连续 duplicate write 最终返回 INVITE_CREATE_FAILED',
    r12 &&
      r12.ok === false &&
      r12.error &&
      r12.error.code === 'INVITE_CREATE_FAILED',
    r12 && r12.error ? r12.error.code : 'no error'
  );
  record(
    '重试耗尽后事务无残留',
    exhaustedAttempts === 8 &&
      colStore('couples').size === 0 &&
      colStore('couple_users').size === 0,
    'attempts=' +
      exhaustedAttempts +
      ' couples=' +
      colStore('couples').size +
      ' users=' +
      colStore('couple_users').size
  );


  // ── T11｜自定义权限：授予 / 查看 / 修改 / 暂停 / 删除 ────────
  console.log('\n[T11] 自定义权限 —— 双方权限管理与归属校验');
  reset();
  await call('pair.create');
  const permissionPairId = [...colStore('couples').keys()][0];
  const permissionInvite = colStore('couples').get(permissionPairId).inviteCode;

  sdk.__setOpenid('OPENID_B');
  await call('pair.join', { inviteCode: permissionInvite });

  sdk.__setOpenid('OPENID_A');
  const pCreate = await call('permission.create', {
    name: '抱抱权',
    note: '每天都可以来一个',
  });
  const permissionId =
    pCreate && pCreate.ok === true && pCreate.data ? pCreate.data.id : '';

  record(
    'A 可以给 B 创建自定义权限',
    pCreate &&
      pCreate.ok === true &&
      pCreate.data.name === '抱抱权' &&
      pCreate.data.fromMe === true &&
      pCreate.data.canManage === true &&
      !!permissionId
  );

  const pListA = await call('permission.list');
  const aView = (pListA && pListA.data && pListA.data[0]) || {};
  record(
    'A 看到“我给 TA”且输出不泄露 openid',
    pListA &&
      pListA.ok === true &&
      aView.direction === 'sent' &&
      aView.grantedBy === undefined &&
      aView.grantedTo === undefined,
    '输出字段: ' + Object.keys(aView).join(',')
  );

  sdk.__setOpenid('OPENID_B');
  const pListB = await call('permission.list');
  const bView = (pListB && pListB.data && pListB.data[0]) || {};
  record(
    'B 看到“TA 给我”且不可管理',
    pListB &&
      pListB.ok === true &&
      bView.direction === 'received' &&
      bView.canManage === false
  );

  const bToggle = await call('permission.toggle', {
    permissionId,
    enabled: false,
  });
  record(
    '接收方不能擅自暂停对方授予的权限',
    bToggle &&
      bToggle.ok === false &&
      bToggle.error &&
      bToggle.error.code === 'PERMISSION_FORBIDDEN',
    bToggle && bToggle.error ? bToggle.error.code : 'no error'
  );

  sdk.__setOpenid('OPENID_A');
  const pUpdate = await call('permission.update', {
    permissionId,
    name: '抱抱权 Pro',
    note: '不开心时也可以申请',
  });
  record(
    '授予方可以修改权限名称和备注',
    pUpdate &&
      pUpdate.ok === true &&
      pUpdate.data.name === '抱抱权 Pro' &&
      pUpdate.data.note === '不开心时也可以申请'
  );

  const pToggle = await call('permission.toggle', {
    permissionId,
    enabled: false,
  });
  record(
    '授予方可以暂停权限',
    pToggle && pToggle.ok === true && pToggle.data.enabled === false
  );

  sdk.__setOpenid('OPENID_B');
  const pAfterToggle = await call('permission.list');
  const bAfterToggle =
    (pAfterToggle && pAfterToggle.data && pAfterToggle.data[0]) || {};
  record(
    '对方能看到修改后的名称和暂停状态',
    pAfterToggle &&
      pAfterToggle.ok === true &&
      bAfterToggle.name === '抱抱权 Pro' &&
      bAfterToggle.enabled === false
  );

  sdk.__setOpenid('OPENID_A');
  const pDelete = await call('permission.delete', { permissionId });
  const pEmpty = await call('permission.list');
  record(
    '授予方删除后双方列表移除该权限',
    pDelete &&
      pDelete.ok === true &&
      pDelete.data.deleted === true &&
      Array.isArray(pEmpty.data) &&
      pEmpty.data.length === 0
  );


  // ── T12｜特权卡：发放 / 使用 / 防重复 / 撤回 ───────────────
  console.log('\n[T12] 特权卡 —— 一次性使用与双方归属');
  reset();
  await call('pair.create');
  const privilegePairId = [...colStore('couples').keys()][0];
  const privilegeInvite = colStore('couples').get(privilegePairId).inviteCode;

  sdk.__setOpenid('OPENID_B');
  await call('pair.join', { inviteCode: privilegeInvite });

  sdk.__setOpenid('OPENID_A');
  const cardCreate = await call('privilege.create', {
    name: '和好一次',
    note: '吵架后可以使用',
  });
  const cardId =
    cardCreate && cardCreate.ok === true && cardCreate.data
      ? cardCreate.data.id
      : '';

  record(
    'A 可以给 B 发一张一次性特权卡',
    cardCreate &&
      cardCreate.ok === true &&
      cardCreate.data.name === '和好一次' &&
      cardCreate.data.status === 'active' &&
      cardCreate.data.fromMe === true &&
      cardCreate.data.canRevoke === true &&
      !!cardId
  );

  const cardListA = await call('privilege.list');
  const cardA = (cardListA && cardListA.data && cardListA.data[0]) || {};
  record(
    '发卡方视角正确且不泄露 openid',
    cardListA &&
      cardListA.ok === true &&
      cardA.direction === 'sent' &&
      cardA.issuedBy === undefined &&
      cardA.issuedTo === undefined,
    '输出字段: ' + Object.keys(cardA).join(',')
  );

  const issuerUse = await call('privilege.use', { cardId });
  record(
    '发卡方不能替接收方使用',
    issuerUse &&
      issuerUse.ok === false &&
      issuerUse.error &&
      issuerUse.error.code === 'PRIVILEGE_CARD_FORBIDDEN',
    issuerUse && issuerUse.error ? issuerUse.error.code : 'no error'
  );

  sdk.__setOpenid('OPENID_B');
  const cardListB = await call('privilege.list');
  const cardB = (cardListB && cardListB.data && cardListB.data[0]) || {};
  record(
    '接收方看到可使用状态',
    cardListB &&
      cardListB.ok === true &&
      cardB.direction === 'received' &&
      cardB.receivedByMe === true &&
      cardB.canUse === true
  );

  const cardUse = await call('privilege.use', { cardId });
  record(
    '接收方使用后卡变为 used',
    cardUse &&
      cardUse.ok === true &&
      cardUse.data.status === 'used' &&
      cardUse.data.canUse === false &&
      !!cardUse.data.usedAt
  );

  const cardReuse = await call('privilege.use', { cardId });
  record(
    '同一张卡不能重复使用',
    cardReuse &&
      cardReuse.ok === false &&
      cardReuse.error &&
      cardReuse.error.code === 'PRIVILEGE_CARD_ALREADY_USED',
    cardReuse && cardReuse.error ? cardReuse.error.code : 'no error'
  );

  sdk.__setOpenid('OPENID_A');
  const revokeUsed = await call('privilege.revoke', { cardId });
  record(
    '已使用的卡不能再撤回',
    revokeUsed &&
      revokeUsed.ok === false &&
      revokeUsed.error &&
      revokeUsed.error.code === 'PRIVILEGE_CARD_ALREADY_USED',
    revokeUsed && revokeUsed.error ? revokeUsed.error.code : 'no error'
  );

  const secondCreate = await call('privilege.create', {
    name: '选片一次',
    note: '',
  });
  const secondId =
    secondCreate && secondCreate.ok === true && secondCreate.data
      ? secondCreate.data.id
      : '';
  const revokeActive = await call('privilege.revoke', { cardId: secondId });
  record(
    '发卡方可以撤回尚未使用的卡',
    revokeActive &&
      revokeActive.ok === true &&
      revokeActive.data.status === 'revoked' &&
      revokeActive.data.canRevoke === false
  );

  sdk.__setOpenid('OPENID_B');
  const useRevoked = await call('privilege.use', { cardId: secondId });
  record(
    '已撤回的卡不能被接收方使用',
    useRevoked &&
      useRevoked.ok === false &&
      useRevoked.error &&
      useRevoked.error.code === 'PRIVILEGE_CARD_ALREADY_USED',
    useRevoked && useRevoked.error ? useRevoked.error.code : 'no error'
  );


  // ── T13｜个人页心情：只能更新自己，对方可查看 ──────────────
  console.log('\n[T13] 个人页心情 —— 自己更新、对方查看');
  reset();
  await call('pair.create');
  const moodPairId = [...colStore('couples').keys()][0];
  const moodInvite = colStore('couples').get(moodPairId).inviteCode;

  sdk.__setOpenid('OPENID_B');
  await call('pair.join', { inviteCode: moodInvite });

  sdk.__setOpenid('OPENID_A');
  const moodUpdateA = await call('profile.mood.update', {
    moodEmoji: '🥰',
    moodText: '今天很开心，想见你',
  });

  record(
    'A 可以更新自己的心情',
    moodUpdateA &&
      moodUpdateA.ok === true &&
      moodUpdateA.data.moodEmoji === '🥰' &&
      moodUpdateA.data.moodText === '今天很开心，想见你' &&
      moodUpdateA.data.hasMood === true &&
      !!moodUpdateA.data.moodUpdatedAt
  );

  const aStored = colStore('couple_users').get('OPENID_A') || {};
  const bStoredBefore = colStore('couple_users').get('OPENID_B') || {};
  record(
    '更新只写自己的 couple_users 文档',
    aStored.moodEmoji === '🥰' &&
      aStored.moodText === '今天很开心，想见你' &&
      bStoredBefore.moodEmoji === undefined &&
      bStoredBefore.moodText === undefined
  );

  const profileA = await call('profile.get');
  record(
    'A 的个人页显示自己的心情，对方初始为空',
    profileA &&
      profileA.ok === true &&
      profileA.data.me.moodEmoji === '🥰' &&
      profileA.data.me.moodText === '今天很开心，想见你' &&
      profileA.data.partner.hasMood === false
  );

  sdk.__setOpenid('OPENID_B');
  const profileB = await call('profile.get');
  record(
    'B 能看到 A 主动分享的当前心情',
    profileB &&
      profileB.ok === true &&
      profileB.data.partner.moodEmoji === '🥰' &&
      profileB.data.partner.moodText === '今天很开心，想见你' &&
      profileB.data.partner.hasMood === true
  );

  record(
    'profile.get 不泄露双方 openid',
    profileB &&
      profileB.ok === true &&
      profileB.data.me.openid === undefined &&
      profileB.data.partner.openid === undefined &&
      profileB.data.me._id === undefined &&
      profileB.data.partner._id === undefined
  );

  const moodUpdateB = await call('profile.mood.update', {
    moodEmoji: '🥺',
    moodText: '今天有点累，想抱抱',
  });
  record(
    'B 也只能更新自己的心情',
    moodUpdateB &&
      moodUpdateB.ok === true &&
      colStore('couple_users').get('OPENID_A').moodEmoji === '🥰' &&
      colStore('couple_users').get('OPENID_B').moodEmoji === '🥺'
  );

  sdk.__setOpenid('OPENID_A');
  const profileAAfter = await call('profile.get');
  record(
    'A 刷新后能看到 B 的最新心情',
    profileAAfter &&
      profileAAfter.ok === true &&
      profileAAfter.data.partner.moodEmoji === '🥺' &&
      profileAAfter.data.partner.moodText === '今天有点累，想抱抱'
  );

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n══════ ${passed}/${results.length} 通过 ══════`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error('测试驱动异常:', e);
  process.exit(2);
});
