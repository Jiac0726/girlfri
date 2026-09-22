const app = getApp();

const WEEKS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const PAGE_SIZE = 20;

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

  // 拉取全部记录（云数据库小程序端单次上限 20 条，分页取完）
  async loadHistory(isPullDown) {
    if (this.data.loading) return;
    this.setData({ loading: true });
    if (!isPullDown) wx.showLoading({ title: '加载中' });

    try {
      const db = wx.cloud.database();
      const all = [];
      let skip = 0;
      for (;;) {
        const res = await db
          .collection(app.globalData.COLLECTION)
          .orderBy('date', 'desc')
          .skip(skip)
          .limit(PAGE_SIZE)
          .get();
        all.push.apply(all, res.data || []);
        if (!res.data || res.data.length < PAGE_SIZE) break;
        skip += PAGE_SIZE;
      }

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
      wx.showToast({ title: '加载失败：' + (e.errMsg || e.message || ''), icon: 'none' });
    } finally {
      this.setData({ loading: false });
      if (!isPullDown) wx.hideLoading();
      else wx.stopPullDownRefresh();
    }
  },
});
