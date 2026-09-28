// 微信云托管（Cloud Run）配置
//
// 本地值写在 config/cloudrun.local.js（不入库），格式见 cloudrun.local.example.js。
// 与 config/env.js 同一套「本地文件 + 示例模板」约定。

let local = {};

try {
  local = require('./cloudrun.local');
} catch (e) {
  // cloudrun.local.js 是本机配置，故意不提交。
}

const service = String((local && local.service) || '').trim();
const env = String((local && local.env) || '').trim();
const baseUrl = String((local && local.baseUrl) || '').trim();

module.exports = {
  // 云托管服务名，写入 X-WX-SERVICE 头。必填。
  service,
  // 云托管环境 ID。留空则回落到 config/env.js 的 cloudEnv。
  env,
  // 容器对外 HTTPS 域名，仅用于调试/降级直连，不参与 callContainer。
  baseUrl,
  configured: !!service,
};
