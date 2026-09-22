const api = require('../../services/cloud');

const WEEKS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

Page({
  data: {
    list: [],
    goodCount: 0,
    badCount: 0,
    totalCount: 0,
    loading: false,
  },

  onShow() {
    this.loadHistory();
  },

  onPullDownRefresh() {
    this.loadHistory(true);
  },

  promptBinding() {
    if (this.bindingPrompted) return;
    this.bindingPrompted = true;
    wx.showModal({
      title: '先完成双人绑定',
      content: '绑定后才能查看两个人的共同记录。',
      confirmText: '去绑定',
      confirmColor: '#ff6b81',
      success: (res) => {
        if (res.confirm) wx.navigateTo({ url: '/pages/bind/bind' });
      },
      complete: () => {
        this.bindingPrompted = false;
      },
    });
  },

  async loadHistory(isPullDown) {
    if (this.data.loading) return;
    this.setData({ loading: true });
    if (!isPullDown) wx.showLoading({ title: '加载中' });

    try {
      const all = await api.listRatings();

      const list = all.map((it) => {
        const d = new Date(it.date + 'T00:00:00');
        return Object.assign({}, it, {
          weekDay: WEEKS[d.getDay()] || '',
          reason: (it.reason || '').trim(),
        });
      });

      const goodCount = list.filter((x) => x.type === 'good').length;

      this.setData({
        list,
        goodCount,
        badCount: list.length - goodCount,
        totalCount: list.length,
      });
    } catch (e) {
      if (api.isBindingError(e)) {
        this.setData({ list: [], goodCount: 0, badCount: 0, totalCount: 0 });
        this.promptBinding();
      } else {
        wx.showToast({ title: '加载失败：' + (e.message || ''), icon: 'none' });
      }
    } finally {
      this.setData({ loading: false });
      if (!isPullDown) wx.hideLoading();
      else wx.stopPullDownRefresh();
    }
  },
});
