Component({
  data: {
    show: false,
    privacyContractName: "用户隐私保护指引",
  },

  lifetimes: {
    attached() {
      // 监听隐私接口需要用户授权事件
      if (wx.onNeedPrivacyAuthorization) {
        wx.onNeedPrivacyAuthorization((resolve) => {
          // 保存 resolve 回调，用户操作后调用
          this._resolvePrivacy = resolve;
          // 获取隐私协议名称
          if (wx.getPrivacySetting) {
            wx.getPrivacySetting({
              success: (res) => {
                if (res.privacyContractName) {
                  this.setData({
                    privacyContractName: res.privacyContractName,
                    show: true,
                  });
                } else {
                  this.setData({ show: true });
                }
              },
              fail: () => {
                this.setData({ show: true });
              },
            });
          } else {
            this.setData({ show: true });
          }
        });
      }
    },
  },

  methods: {
    // 打开隐私协议详情
    openPrivacyContract() {
      wx.openPrivacyContract({
        fail: () => {
          wx.showToast({ title: "打开失败", icon: "none" });
        },
      });
    },

    // 用户同意
    handleAgree() {
      this.setData({ show: false });
      if (this._resolvePrivacy) {
        this._resolvePrivacy({ buttonId: "agree-btn", event: "agree" });
        this._resolvePrivacy = null;
      }
    },

    // 用户拒绝
    handleReject() {
      this.setData({ show: false });
      if (this._resolvePrivacy) {
        this._resolvePrivacy({ event: "disagree" });
        this._resolvePrivacy = null;
      }
    },

    // 阻止穿透滚动
    preventMove() {},
  },
});
