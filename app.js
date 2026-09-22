// app.js
App({
  onLaunch() {
    if (!wx.cloud) {
      console.error('基础库版本过低，请使用 2.2.3 及以上版本，或升级微信客户端');
      return;
    }
    wx.cloud.init({
      // ⚠️ 替换成你自己的云开发环境 ID（云开发控制台首页可见）
      env: 'YOUR_ENV_ID',
      traceUser: true,
    });
  },

  globalData: {
    GOOD: 'good',
    BAD: 'bad',
  },
});
