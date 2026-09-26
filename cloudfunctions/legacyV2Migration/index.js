'use strict';

const cloud = require('wx-server-sdk');
const { transformLegacy } = require('./migration');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const MARKER_ID = 'legacy_v1_to_v2';
const TARGETS = [
  'v2_users',
  'v2_couples',
  'v2_invites',
  'v2_entries',
  'v2_agreements',
  'v2_coupons',
  'v2_coupon_requests',
  'v2_media',
];
const WRITABLE_TARGETS = TARGETS.filter(name => name !== 'v2_media');

function forbiddenFromMiniProgram() {
  const ctx = cloud.getWXContext ? cloud.getWXContext() : {};
  return !!(ctx && ctx.OPENID);
}

async function readAll(name) {
  const rows = [];
  const limit = 100;
  for (let skip = 0; ; skip += limit) {
    const result = await db.collection(name).orderBy('_id', 'asc').skip(skip).limit(limit).get();
    const page = result && result.data || [];
    rows.push(...page);
    if (page.length < limit) break;
  }
  return rows;
}

async function firstDoc(name) {
  try {
    const result = await db.collection(name).limit(1).get();
    return result && result.data && result.data[0] || null;
  } catch (error) {
    return { __collectionError: String((error && (error.errMsg || error.message)) || error) };
  }
}

async function targetState() {
  const state = {};
  for (const name of TARGETS) {
    const first = await firstDoc(name);
    state[name] = {
      exists: !(first && first.__collectionError),
      empty: !first,
      firstId: first && !first.__collectionError ? first._id : '',
      error: first && first.__collectionError || '',
    };
  }
  return state;
}

async function marker() {
  try {
    const result = await db.collection('v2_operations').doc(MARKER_ID).get();
    return result && result.data || null;
  } catch (_) {
    return null;
  }
}

async function setMarker(data) {
  const payload = Object.assign({ updatedAt: new Date() }, data);
  await db.collection('v2_operations').doc(MARKER_ID).set({ data: payload });
}

function withoutId(doc) {
  const out = Object.assign({}, doc);
  delete out._id;
  return out;
}

async function writeDocuments(collectionName, docs) {
  const batchSize = 20;
  for (let i = 0; i < docs.length; i += batchSize) {
    const batch = docs.slice(i, i + batchSize);
    await Promise.all(batch.map(doc =>
      db.collection(collectionName).doc(doc._id).set({ data: withoutId(doc) })
    ));
  }
}

async function loadLegacy() {
  const [couples, users, ratings] = await Promise.all([
    readAll('couples'),
    readAll('couple_users'),
    readAll('ratings'),
  ]);
  return { couples, users, ratings };
}

async function plan() {
  const legacy = await loadLegacy();
  const transformed = transformLegacy(legacy, new Date());
  const targets = await targetState();
  const currentMarker = await marker();
  return {
    ok: transformed.ok,
    counts: transformed.counts,
    blockers: transformed.blockers,
    warnings: transformed.warnings,
    targets,
    marker: currentMarker && {
      status: currentMarker.status,
      startedAt: currentMarker.startedAt,
      completedAt: currentMarker.completedAt,
      progress: currentMarker.progress,
    },
  };
}

async function apply(event) {
  if (event.confirm !== 'MIGRATE_V2_FROM_LEGACY') {
    throw new Error('CONFIRM_REQUIRED: confirm must equal MIGRATE_V2_FROM_LEGACY');
  }

  const legacy = await loadLegacy();
  const transformed = transformLegacy(legacy, new Date());
  if (!transformed.ok) {
    return { ok: false, stage: 'validation', counts: transformed.counts, blockers: transformed.blockers, warnings: transformed.warnings };
  }

  const currentMarker = await marker();
  if (currentMarker && currentMarker.status === 'completed') {
    return { ok: true, alreadyCompleted: true, receipt: currentMarker.receipt || currentMarker };
  }

  const resume = !!(currentMarker && currentMarker.status === 'running');
  if (!resume) {
    const targets = await targetState();
    const unavailable = Object.entries(targets).filter(([, state]) => !state.exists);
    if (unavailable.length) {
      return {
        ok: false,
        stage: 'targets',
        error: '请先按 config/database.v2.json 创建全部 v2 集合',
        unavailable: unavailable.map(([name, state]) => ({ name, error: state.error })),
      };
    }
    const nonEmpty = Object.entries(targets).filter(([, state]) => !state.empty);
    if (nonEmpty.length) {
      return {
        ok: false,
        stage: 'targets',
        error: '检测到 v2 目标集合已有数据。为避免覆盖，迁移已停止。',
        nonEmpty: nonEmpty.map(([name, state]) => ({ name, firstId: state.firstId })),
      };
    }
    await setMarker({
      status: 'running',
      startedAt: new Date(),
      sourceCounts: transformed.counts,
      progress: {},
    });
  }

  const progress = Object.assign({}, currentMarker && currentMarker.progress || {});
  try {
    for (const name of WRITABLE_TARGETS) {
      const docs = transformed.documents[name] || [];
      await writeDocuments(name, docs);
      progress[name] = docs.length;
      await setMarker({
        status: 'running',
        startedAt: currentMarker && currentMarker.startedAt || new Date(),
        sourceCounts: transformed.counts,
        progress,
      });
    }

    const receipt = {
      completedAt: new Date(),
      counts: transformed.counts,
      warnings: transformed.warnings,
      sourceCollectionsKept: true,
      relationshipIdsPreserved: true,
      usersNeedRebind: false,
    };
    await setMarker({
      status: 'completed',
      startedAt: currentMarker && currentMarker.startedAt || new Date(),
      completedAt: receipt.completedAt,
      sourceCounts: transformed.counts,
      progress,
      receipt,
    });

    return { ok: true, receipt };
  } catch (error) {
    await setMarker({
      status: 'running',
      startedAt: currentMarker && currentMarker.startedAt || new Date(),
      sourceCounts: transformed.counts,
      progress,
      lastError: String((error && (error.errMsg || error.message)) || error).slice(0, 500),
      failedAt: new Date(),
    }).catch(() => null);
    throw error;
  }
}

exports.main = async (event) => {
  try {
    if (forbiddenFromMiniProgram()) {
      return { ok: false, error: { code: 'FORBIDDEN', message: '迁移函数只能由管理员从 CloudBase CLI/控制台调用' } };
    }
    const mode = String(event && event.mode || 'plan');
    if (mode === 'plan') return await plan();
    if (mode === 'apply') return await apply(event || {});
    return { ok: false, error: { code: 'INVALID_MODE', message: 'mode 只能是 plan 或 apply' } };
  } catch (error) {
    console.error('[legacyV2Migration]', error);
    return {
      ok: false,
      error: {
        code: 'MIGRATION_FAILED',
        message: String((error && (error.errMsg || error.message)) || error),
      },
    };
  }
};
