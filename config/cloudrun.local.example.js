// 微信云托管本地配置 —— 复制成 config/cloudrun.local.js 后按需修改
// config/cloudrun.local.js 不入库（含环境标识），已在 .gitignore 中忽略。
//
// 以下三个值来自微信云托管控制台「调用示例」：
//   wx.cloud.callContainer({
//     config: { env: "prod-d4g9sgvitc679a8cf" },
//     path: "/api/count",
//     header: { "X-WX-SERVICE": "springboot-o4gu" },
//     method: "POST",
//     data: { action: "inc" }
//   })

module.exports = {
  // 云托管服务名 —— 对应 X-WX-SERVICE 头
  service: 'springboot-o4gu',

  // 云托管环境 ID —— 对应 callContainer 的 config.env
  // （留空则回落到 config/env.js 的 cloudEnv）
  env: 'prod-d4g9sgvitc679a8cf',

  // 容器对外 HTTPS 域名，仅用于调试或直连降级，不参与 callContainer
  baseUrl: 'https://springboot-o4gu-320950-12-1493828096.sh.run.tcloudbase.com',
};
