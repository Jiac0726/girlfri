// wx-server-sdk 内存 mock —— 仅供 tests/renian-api/race.test.js 使用
// 集合按需自动创建（真库集合名是 couples / couple_users / ratings，
// 首版 mock 写死成 users 导致 store[key] 为 undefined、跑出假结果，已修）。
const store = {};
const hooks = {};

function colStore(col) {
  if (!store[col]) store[col] = new Map();
  return store[col];
}

function notFound() {
  const e = new Error('document not exists');
  e.code = -1;
  return e;
}

function withId(id, data) {
  return Object.assign({ _id: id }, structuredClone(data));
}

function docRef(col, id) {
  return {
    async get() {
      if (hooks.beforeGet) await hooks.beforeGet(col, id);
      const cs = colStore(col);
      if (!cs.has(id)) throw notFound();
      // 先取快照再触发 afterGet：调用方拿到旧值、store 已被篡改，
      // 这样才能精确复现 TOCTOU（读到 waiting → 对方加入 → 事务执行）。
      const out = { data: withId(id, cs.get(id)) };
      if (hooks.afterGet) await hooks.afterGet(col, id);
      return out;
    },
    async set({ data }) {
      if (hooks.beforeSet) await hooks.beforeSet(col, id, data);
      colStore(col).set(id, structuredClone(data));
      return { _id: id };
    },
    async update({ data }) {
      if (hooks.beforeUpdate) await hooks.beforeUpdate(col, id, data);
      const cs = colStore(col);
      if (!cs.has(id)) throw notFound();
      cs.set(id, Object.assign(cs.get(id), structuredClone(data)));
      return {};
    },
    async remove() {
      colStore(col).delete(id);
      return {};
    },
  };
}

function queryRef(col) {
  const state = { criteria: null, skip: 0, limit: Infinity, order: [] };
  const api = {
    where(cond) {
      state.criteria = cond;
      return api;
    },
    skip(n) {
      state.skip = n;
      return api;
    },
    limit(n) {
      state.limit = n;
      return api;
    },
    orderBy(field, order) {
      // 真排序：否则 P4（skip/limit 需全序）测不出来
      state.order.push([field, order === 'desc' ? -1 : 1]);
      return api;
    },
    async get() {
      if (hooks.beforeQuery) await hooks.beforeQuery(col, state.criteria);
      let rows = [...colStore(col).entries()].map(([id, d]) => withId(id, d));
      if (state.criteria) {
        rows = rows.filter((r) =>
          Object.entries(state.criteria).every(([k, v]) => r[k] === v)
        );
      }
      if (state.order.length) {
        rows.sort((a, b) => {
          for (const [f, dir] of state.order) {
            if (a[f] === b[f]) continue;
            return a[f] < b[f] ? -dir : dir;
          }
          return 0;
        });
      }
      rows = rows.slice(state.skip, state.skip + state.limit);
      return { data: rows };
    },
  };
  return api;
}

function collection(col) {
  return Object.assign({ doc: (id) => docRef(col, id) }, queryRef(col));
}

function snapshot() {
  const snap = {};
  for (const k of Object.keys(store)) snap[k] = Object.fromEntries(store[k]);
  return snap;
}

function restore(snap) {
  for (const k of Object.keys(store)) delete store[k];
  for (const k of Object.keys(snap)) store[k] = new Map(Object.entries(snap[k]));
}

async function runTransaction(fn) {
  // 快照 + 失败回滚（真库是乐观锁重试，这里够用）
  const snap = snapshot();
  const tx = { collection: (c) => collection(c) };
  try {
    return await fn(tx);
  } catch (e) {
    restore(snap);
    throw e;
  }
}

const cloud = {
  init() {},
  DYNAMIC_CURRENT_ENV: 'mock-env',
  _openid: 'OPENID_A',
  getWXContext() {
    return { OPENID: cloud._openid };
  },
};

module.exports = Object.assign(cloud, {
  database: () => ({ collection, runTransaction }),
  __store: store,
  __colStore: colStore,
  __hooks: hooks,
  __setOpenid: (v) => (cloud._openid = v),
  __reset: () => {
    for (const k of Object.keys(store)) delete store[k];
    for (const k of Object.keys(hooks)) delete hooks[k];
  },
});
