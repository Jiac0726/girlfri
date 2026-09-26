// In-memory transactional test double. Transactions serialize; production uses SDK conflict retries.
const store = {}, hooks = {};
const colStore = name => store[name] || (store[name] = new Map());
function missing() { const e = new Error('document not exists'); e.code = 'DATABASE_DOCUMENT_NOT_EXIST'; return e; }
function row(id, data) { return Object.assign({ _id: id }, structuredClone(data)); }
const command = {};
for (const op of ['lt','lte','gt','gte','eq','neq','in']) command[op] = value => ({ $op: op, value });
command.and = value => ({ $op: 'and', value });
command.or = value => ({ $op: 'or', value });
function match(actual, wanted) {
  if (wanted && wanted.$op) {
    const v = wanted.value;
    switch (wanted.$op) {
      case 'and': return v.every(x => match(actual, x));
      case 'or': return v.some(x => match(actual, x));
      case 'lt': return actual < v; case 'lte': return actual <= v;
      case 'gt': return actual > v; case 'gte': return actual >= v;
      case 'eq': return match(actual, v); case 'neq': return !match(actual, v);
      case 'in': return v.some(x => match(actual, x));
    }
  }
  if (wanted instanceof Date) return new Date(actual).getTime() === wanted.getTime();
  if (wanted && typeof wanted === 'object') return Object.entries(wanted).every(([k,v]) => match(actual && actual[k], v));
  return actual === wanted;
}
function document(col, id) {
  return {
    async get() {
      if (hooks.beforeGet) await hooks.beforeGet(col, id);
      if (!colStore(col).has(id)) throw missing();
      const data = row(id, colStore(col).get(id));
      if (hooks.afterGet) await hooks.afterGet(col, id);
      return { data };
    },
    async set({data}) { if (hooks.beforeSet) await hooks.beforeSet(col, id, data); colStore(col).set(id, structuredClone(data)); return { _id: id }; },
    async update({data}) { if (hooks.beforeUpdate) await hooks.beforeUpdate(col, id, data); if (!colStore(col).has(id)) throw missing(); colStore(col).set(id, Object.assign({}, colStore(col).get(id), structuredClone(data))); return {}; },
    async remove() { colStore(col).delete(id); return {}; },
  };
}
function collection(col) {
  let criteria = {}, limit = Infinity, skip = 0, order = [];
  const rows = () => [...colStore(col)].map(([id,d]) => row(id,d)).filter(x => match(x, criteria));
  const api = {
    doc: id => document(col, id),
    where(value) { criteria = value; return api; },
    limit(value) { limit = value; return api; },
    skip(value) { skip = value; return api; },
    orderBy(field, direction) { order.push([field, direction === 'desc' ? -1 : 1]); return api; },
    async count() { return { total: rows().length }; },
    async get() {
      if (hooks.beforeQuery) await hooks.beforeQuery(col, criteria);
      const data = rows().sort((a,b) => {
        for (const [key, dir] of order) {
          const av = a[key] instanceof Date ? a[key].getTime() : a[key], bv = b[key] instanceof Date ? b[key].getTime() : b[key];
          if (av !== bv) return av < bv ? -dir : dir;
        }
        return 0;
      });
      return { data: data.slice(skip, skip + limit) };
    },
  };
  return api;
}
function nodeDocument(col, id) {
  const raw = document(col, id);
  return {
    async get() {
      const result = await raw.get();
      return { data: result && result.data ? [result.data] : [] };
    },
    async set(data) { return raw.set({ data }); },
    async update(data) { return raw.update({ data }); },
    async remove() { return raw.remove(); },
  };
}
function nodeCollection(col) {
  const raw = collection(col);
  const api = {
    doc: id => nodeDocument(col, id),
    where(value) { raw.where(value); return api; },
    limit(value) { raw.limit(value); return api; },
    skip(value) { raw.skip(value); return api; },
    orderBy(field, direction) { raw.orderBy(field, direction); return api; },
    count: () => raw.count(),
    get: () => raw.get(),
  };
  return api;
}
function nodeDatabase() {
  return {
    collection: nodeCollection,
    command,
    async runTransaction(fn) {
      const result = await runTransaction(async () => fn({ collection: nodeCollection }));
      return { result, errMsg: 'runTransaction:ok' };
    },
  };
}
let queue = Promise.resolve();
function runTransaction(fn) {
  const result = queue.then(async () => {
    const snapshot = structuredClone(store);
    try { return await fn({ collection }); }
    catch (error) { for (const key of Object.keys(store)) delete store[key]; Object.assign(store, snapshot); throw error; }
  });
  queue = result.catch(() => {}); return result;
}
const files = new Map();
const cloud = {
  init() {}, DYNAMIC_CURRENT_ENV: 'mock-env', _openid: 'A',
  getWXContext: () => ({ OPENID: cloud._openid, ENV: 'mock-env' }),
  database: () => ({ collection, runTransaction, command }),
  __nodeDatabase: nodeDatabase,
  async getTempFileURL({fileList}) { return { fileList: fileList.map(fileID => ({ fileID, status: 0, tempFileURL: 'https://mock.invalid/' + encodeURIComponent(fileID) })) }; },
  async uploadFile({cloudPath, fileContent}) { const fileID = 'cloud://mock-env.bucket/' + cloudPath; files.set(fileID, Buffer.from(fileContent)); return { fileID }; },
  async downloadFile({fileID}) { if (!files.has(fileID)) throw new Error('missing file'); return { fileContent: files.get(fileID) }; },
  async deleteFile({fileList}) { return { fileList: fileList.map(fileID => { files.delete(fileID); return { fileID, status: 0 }; }) }; },
  openapi: { subscribeMessage: { send: async () => ({}) } },
  __store: store, __colStore: colStore, __hooks: hooks, __files: files,
  __setOpenid(value) { cloud._openid = value; },
  __reset() { for (const key of Object.keys(store)) delete store[key]; for (const key of Object.keys(hooks)) delete hooks[key]; files.clear(); },
};
module.exports = cloud;
