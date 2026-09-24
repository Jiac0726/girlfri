const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Run the actual Page definition; only the WeChat shell and remote API are mocked.
function loadPage(name, api, options = {}) {
  let page;
  const events = [];
  const wx = {};
  ['showLoading', 'hideLoading', 'showToast', 'showModal', 'stopPullDownRefresh',
    'navigateTo', 'navigateBack', 'switchTab'].forEach((method) => {
    wx[method] = (value) => events.push({ method, value });
  });
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages', name, name + '.js'), 'utf8'), {
    Page: (definition) => { page = definition; },
    require: () => Object.assign({ isBindingError: () => false }, api),
    getApp: () => ({ globalData: { GOOD: 'good', NEUTRAL: 'neutral', BAD: 'bad' } }),
    wx, console,
  });
  page.data = JSON.parse(JSON.stringify(page.data));
  page.setData = (update) => Object.assign(page.data, update);
  if (page.onLoad) page.onLoad(options);
  return { page, events };
}

const today = (rating = null, date = '2026-09-24') => ({ date, rating, canRate: true, partnerRating: null });

test('today editor stays locked until the initial rating arrives, then saves normally', async () => {
  const initial = deferred();
  let saved = null, reads = 0, writes = 0;
  const { page } = loadPage('index', {
    getSession: async () => ({ bindingStatus: 'active' }),
    getToday: () => ++reads === 1 ? initial.promise : Promise.resolve(today(saved)),
    listRatings: async () => [],
    saveToday: async (type, reason) => { writes++; saved = { type, reason }; return today(saved); },
  });
  const opening = page.onShow();
  await tick();
  page.selectGood();
  page.onReasonInput({ detail: { value: 'too early' } });
  await page.submit();
  assert.equal(page.data.canRate, false);
  assert.equal(page.data.authLoading, true);
  assert.equal(page.data.reason, '');
  assert.equal(writes, 0);
  initial.resolve(today());
  await opening;
  page.selectGood();
  page.onReasonInput({ detail: { value: 'new entry' } });
  await page.submit();
  assert.equal(writes, 1);
  assert.equal(page.data.submitted, true);
  assert.equal(page.data.reason, 'new entry');
});

test('an older rating response cannot clear a newer saved result', async () => {
  const old = deferred();
  let reads = 0;
  let saved = { type: 'good', reason: 'current' };
  const { page } = loadPage('index', {
    getSession: async () => ({ bindingStatus: 'active' }),
    getToday: () => ++reads === 1 ? old.promise : Promise.resolve(today(saved)),
    listRatings: async () => [],
    saveToday: async (type, reason) => { saved = { type, reason }; return today(saved); },
  });
  const staleLoad = page.onShow();
  await tick();
  await page.onShow();
  page.editToday();
  page.selectNeutral();
  page.onReasonInput({ detail: { value: 'corrected' } });
  await page.submit();
  old.resolve(today());
  await staleLoad;
  assert.equal(page.data.submitted, true);
  assert.equal(page.data.type, 'neutral');
  assert.equal(page.data.reason, 'corrected');
});

test('an older session response cannot restore an obsolete binding', async () => {
  const old = deferred();
  let sessions = 0, reads = 0;
  const { page } = loadPage('index', {
    getSession: () => ++sessions === 1 ? old.promise : Promise.resolve({ bindingStatus: 'unbound' }),
    getToday: async () => { reads++; return today(); },
  });
  const first = page.onShow();
  await page.onShow();
  old.resolve({ bindingStatus: 'active' });
  await first;
  assert.equal(page.data.bindingStatus, 'unbound');
  assert.equal(page.data.canRate, false);
  assert.equal(reads, 0);
});

test('visible dates and monthly stats follow the server across month boundaries', async () => {
  let date = '2026-01-31';
  const { page } = loadPage('index', {
    getSession: async () => ({ bindingStatus: 'active' }),
    getToday: async () => today(null, date),
    listRatings: async () => [
      { date: '2026-01-31', type: 'bad' },
      { date: '2026-02-01', type: 'good' },
    ],
  });
  await page.onShow();
  assert.equal(page.data.dayNum, '31');
  date = '2026-02-01';
  await page.onShow();
  assert.equal(page.data.dayNum, '01');
  assert.equal(page.data.yearMonth, '2026年02月');
  assert.equal(page.data.weekDay, '周日');
  assert.equal(page.data.monthGoodRate, 100);
});

test('today load failure leaves a retryable state and never enables a blank editor', async () => {
  let offline = true;
  const { page } = loadPage('index', {
    getSession: async () => ({ bindingStatus: 'active' }),
    getToday: async () => { if (offline) throw new Error('offline'); return today(); },
    listRatings: async () => [],
  });
  await page.onShow();
  assert.equal(page.data.authLoading, false);
  assert.equal(page.data.canRate, false);
  assert.ok(page.data.loadError);
  offline = false;
  await page.refreshSession();
  assert.equal(page.data.canRate, true);
  assert.equal(page.data.loadError, '');
});

test('failed binding load can retry without losing the incoming invitation', async () => {
  let offline = true;
  const { page, events } = loadPage('bind', {
    getSession: async () => { if (offline) throw new Error('offline'); return { bindingStatus: 'unbound' }; },
  }, { inviteCode: 'ABCD2345' });
  await page.refresh();
  assert.equal(page.data.bindingStatus, 'error');
  assert.equal(page.data.loading, false);
  offline = false;
  await page.onPullDownRefresh();
  assert.equal(page.data.bindingStatus, 'unbound');
  assert.equal(page.data.joinCode, 'ABCD2345');
  assert.equal(page.data.openedFromInvite, true);
  assert.ok(events.some((event) => event.method === 'stopPullDownRefresh'));
});

test('waiting inviter can refresh to the active state after their partner joins', async () => {
  let status = 'waiting';
  const { page } = loadPage('bind', {
    getSession: async () => ({ bindingStatus: status }),
  });
  await page.refresh();
  status = 'active';
  await page.retrySession();
  assert.equal(page.data.bindingStatus, 'active');
});

for (const config of [
  { page: 'permissions', read: 'listPermissions', write: 'createPermission', load: 'loadPermissions', save: 'submitPermission', list: 'myPermissions' },
  { page: 'privileges', read: 'listPrivilegeCards', write: 'createPrivilegeCard', load: 'loadCards', save: 'createCard', list: 'sentActive' },
]) {
  for (const oldFirst of [true, false]) {
    test(config.page + ': mutation refresh survives an in-flight list (' + (oldFirst ? 'old first' : 'old last') + ')', async () => {
      const old = deferred(), fresh = deferred();
      let reads = 0, writes = 0;
      const item = { id: 'new', name: 'new item', fromMe: true, status: 'active', enabled: true };
      const { page } = loadPage(config.page, {
        [config.read]: () => ++reads === 1 ? old.promise : fresh.promise,
        [config.write]: async () => { writes++; return item; },
      });
      const initialLoad = page[config.load]();
      page.setData({ name: 'new item' });
      const saving = page[config.save]();
      await tick();
      assert.equal(reads, 2, 'a fresh list request must follow the mutation');
      assert.equal(writes, 1);
      if (oldFirst) {
        old.resolve([]);
        await initialLoad;
        assert.equal(page.data.loading, true, 'old completion must not end the new request');
      }
      fresh.resolve([item]);
      await saving;
      if (!oldFirst) { old.resolve([]); await initialLoad; }
      assert.equal(page.data[config.list].length, 1);
      assert.equal(page.data[config.list][0].id, 'new');
      assert.equal(page.data.loading, false);
    });
  }
}
