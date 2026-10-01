// services/cloudrun.js —— 微信云托管 callContainer 封装的回归测试
//
// 用 vm 沙箱加载被测模块，拦截 require 与 wx，与 tests/frontend/pages.test.js 同风格。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const TARGET = path.join(root, 'services/cloudrun.js');

/** 载入 services/cloudrun.js，注入假的 config 与 wx.cloud.callContainer */
function load(options) {
  const opts = options || {};
  const calls = [];
  const cfg = Object.assign(
    { service: 'springboot-o4gu', env: 'prod-d4g9sgvitc679a8cf', baseUrl: '', configured: true },
    opts.config || {}
  );
  const envCfg = Object.assign({ cloudEnv: 'env-from-config-env' }, opts.envConfig || {});

  const wx = {
    cloud: {
      callContainer: (payload) => {
        calls.push(payload);
        if (opts.reject) return Promise.reject(opts.reject);
        return Promise.resolve(opts.resolve || { statusCode: 200, data: { ok: true } });
      },
    },
  };

  const module = { exports: {} };
  const localRequire = (spec) => {
    if (spec === '../config/cloudrun') return cfg;
    if (spec === '../config/env') return envCfg;
    throw new Error('测试未预期的 require: ' + spec);
  };
  vm.runInNewContext(fs.readFileSync(TARGET, 'utf8'), {
    require: localRequire,
    module,
    exports: module.exports,
    wx,
    console: { error() {}, log() {} },
  }, { filename: TARGET });

  return { api: module.exports, calls, cfg, envCfg };
}

test('缺少 path 时拒绝', async () => {
  const { api } = load();
  await assert.rejects(() => api.callContainer({}), /需要以 \/ 开头的 path/);
  await assert.rejects(() => api.callContainer({ path: 'api/count' }), /需要以 \/ 开头的 path/);
});

test('正确组装 config / path / method / header', async () => {
  const { api, calls } = load();
  await api.callContainer({ path: '/api/count', method: 'post', data: { action: 'inc' } });
  assert.equal(calls.length, 1);
  const p = calls[0];
  assert.equal(p.path, '/api/count');
  assert.equal(p.method, 'POST');            // 统一大写
  // 跨 realm：逐字段比
  assert.equal(p.data.action, 'inc');
  assert.equal(p.config.env, 'prod-d4g9sgvitc679a8cf');
  assert.equal(p.header['X-WX-SERVICE'], 'springboot-o4gu');
  assert.equal(p.header['content-type'], 'application/json');
});

test('X-WX-SERVICE 由封装注入，调用方无法覆盖', async () => {
  const { api, calls } = load();
  await api.callContainer({
    path: '/api/count',
    header: { 'X-WX-SERVICE': 'evil-service', 'X-Custom': 'v' },
  });
  assert.equal(calls[0].header['X-WX-SERVICE'], 'springboot-o4gu');
  assert.equal(calls[0].header['X-Custom'], 'v');
});

test('未配置云托管 env 时回落到 config/env.js 的 cloudEnv', async () => {
  const { api, calls } = load({ config: { service: 'springboot-o4gu', env: '' } });
  await api.callContainer({ path: '/api/count' });
  assert.equal(calls[0].config.env, 'env-from-config-env');
});

test('服务端 reject 时包装为 CONTAINER_INVOKE_FAILED', async () => {
  const { api } = load({ reject: new Error('callContainer:fail timeout') });
  await assert.rejects(
    () => api.callContainer({ path: '/api/count' }),
    (err) => {
      assert.equal(err.code, 'CONTAINER_INVOKE_FAILED');
      assert.match(err.message, /springboot-o4gu/);
      assert.equal(err.service, 'springboot-o4gu');
      // ⚠️ 逐字段断言而不用 deepEqual：err.request 是在 vm 沙箱里创建的，
      // 它的 Object.prototype 与测试侧不是同一个，deepStrictEqual 会连
      // 原型一起比而报「同结构但非引用相等」。跨 realm 对象一律拆开比。
      assert.equal(err.request.path, '/api/count');
      assert.equal(err.request.method, 'GET');
      return true;
    }
  );
});

test('非 2xx 抛 CONTAINER_HTTP_ERROR 且保留状态码与响应体', async () => {
  const { api } = load({ resolve: { statusCode: 502, data: { msg: 'bad gateway' } } });
  await assert.rejects(
    () => api.callContainer({ path: '/api/count', method: 'POST' }),
    (err) => {
      assert.equal(err.code, 'CONTAINER_HTTP_ERROR');
      assert.equal(err.statusCode, 502);
      // 跨 realm：逐字段比，不用 deepEqual
      assert.equal(err.body.msg, 'bad gateway');
      return true;
    }
  );
});

test('2xx 放行并返回 res.data', async () => {
  const { api } = load({ resolve: { statusCode: 201, data: { n: 3 } } });
  assert.deepEqual(await api.callContainer({ path: '/api/count' }), { n: 3 });
});

test('pingCounter 走 /api/count，action 只认 inc/clear', async () => {
  const { api, calls } = load();
  await api.pingCounter('inc');
  await api.pingCounter('clear');
  await api.pingCounter('随便什么');   // 非 clear 一律归一为 inc
  assert.equal(calls.length, 3);
  // 跨 realm：逐条比，不用 deepEqual
  assert.deepEqual(calls.map((c) => String(c.data.action)), ['inc', 'clear', 'inc']);
  assert.ok(calls.every((c) => c.path === '/api/count' && c.method === 'POST'));
  // 反向断言：真实 CounterController 只认 inc / clear，没有 dec
  assert.ok(
    calls.every((c) => ['inc', 'clear'].includes(String(c.data.action))),
    'action 只能是 inc 或 clear（模板源码 CounterController 无 dec 分支）'
  );
});

test('未配 service 时 configured 为 false（来自 config/cloudrun.js）', () => {
  // 这条验的是 config 的判定，不是封装；若 config 改了需同步这里
  const src = fs.readFileSync(path.join(root, 'config/cloudrun.js'), 'utf8');
  assert.match(src, /configured:\s*!!service/);
});
