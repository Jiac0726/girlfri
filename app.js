const env = require('./config/env');

App({
  onLaunch() {
    if (!wx.cloud) {
      console.error('基础库版本过低，请使用 2.2.3 及以上版本，或升级微信客户端');
      return;
    }
    if (!env.configured) {
      console.error('未配置云开发环境。请先运行 setup-local.cmd，生成 config/env.local.js。');
      return;
    }
    wx.cloud.init({ env: env.cloudEnv, traceUser: true });
  },
  globalData: {},
});
