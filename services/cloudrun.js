// 微信云托管（Cloud Run）容器调用封装
//
// 通过 wx.cloud.callContainer 调用云托管上的 Spring Boot 服务。
// 相比 wx.cloud.callFunction，这条路走的是 HTTP 容器：
//   - 路径、方法、请求体完全由后端服务定义
//   - X-WX-SERVICE 头由平台注入，服务端可据此识别调用来源
//   - 鉴权走 openid（由平台注入到容器的请求头）
//
// 配置见 config/cloudrun.js；服务端模板：WeixinCloud/wxcloudrun-springboot

const env = require('../config/env');
const cloudrun = require('../config/cloudrun');

function toError(error, meta) {
  const raw = String(
    (error && (error.errMsg || error.message)) || error || '未知容器调用错误'
  );
  const err = new Error(
    '云托管服务调用失败（' +
      (cloudrun.service || '未配置服务') +
      '）：' +
      raw
  );
  err.code = 'CONTAINER_INVOKE_FAILED';
  err.raw = error;
  err.service = cloudrun.service;
  err.request = meta || null;
  return err;
}

/**
 * 调用云托管容器的一个 HTTP 接口
 *
 * @param {Object} opts
 * @param {string} opts.path        接口路径，如 '/api/count'
 * @param {string} [opts.method]    HTTP 方法，默认 GET
 * @param {*}      [opts.data]      请求体（POST/PUT 时生效）
 * @param {Object} [opts.header]    追加请求头（不要自己写 X-WX-SERVICE，会被覆盖）
 * @param {number} [opts.timeout]   超时毫秒数
 * @returns {Promise<*>} 服务端响应体
 */
async function callContainer(opts) {
  const options = opts || {};
  const path = String(options.path || '');
  if (!path || path.charAt(0) !== '/') {
    throw new Error('callContainer 需要以 / 开头的 path');
  }

  const method = String(options.method || 'GET').toUpperCase();
  const header = Object.assign({}, options.header || {}, {
    // 平台约定头：标识目标云托管服务，不允许调用方覆盖
    'X-WX-SERVICE': cloudrun.service,
    'content-type': 'application/json',
  });

  let res;
  try {
    res = await wx.cloud.callContainer({
      config: {
        // 云托管环境 ID；留空则回落到小程序自身的云环境
        env: cloudrun.env || env.cloudEnv,
      },
      path,
      header,
      method,
      data: options.data,
      timeout: options.timeout,
    });
  } catch (error) {
    console.error('[renian cloudrun invoke failed]', {
      service: cloudrun.service,
      path,
      method,
      cloudEnv: cloudrun.env || env.cloudEnv,
      error,
    });
    throw toError(error, { path, method });
  }

  // callContainer 对非 2xx 也可能 resolve，统一在这里拦
  const status = res && res.statusCode;
  if (typeof status === 'number' && (status < 200 || status >= 300)) {
    const err = new Error('云托管服务返回 HTTP ' + status);
    err.code = 'CONTAINER_HTTP_ERROR';
    err.statusCode = status;
    err.body = res && res.data;
    err.request = { path, method };
    console.error('[renian cloudrun bad status]', {
      service: cloudrun.service,
      path,
      method,
      statusCode: status,
    });
    throw err;
  }

  return res && res.data;
}

/** 便捷方法：把模板的 /api/count 计数器包一层，便于联调验证链路通不通 */
function pingCounter(action) {
  return callContainer({
    path: '/api/count',
    method: 'POST',
    data: { action: action === 'dec' ? 'dec' : 'inc' },
  });
}

module.exports = {
  callContainer,
  pingCounter,
  service: cloudrun.service,
  baseUrl: cloudrun.baseUrl,
};
