Page({
  data: {
    version: 'V2',
  },

  goBack() {
    wx.navigateBack({ delta: 1 });
  },

  openWechatSettings() {
    wx.openSetting({
      success: () => {
        wx.showToast({ title: '设置已更新', icon: 'none' });
      },
    });
  },

  showPrivacy() {
    wx.showModal({
      title: '隐私说明',
      content: '“热念”只在必要范围内保存双人空间所需的数据。恋爱备忘录仅对本人可见，不会展示给另一方。',
      showCancel: false,
    });
  },

  showAbout() {
    wx.showModal({
      title: '关于热念',
      content: '两个人的相处记录\n记录日常，也记得彼此。',
      showCancel: false,
    });
  },
});
