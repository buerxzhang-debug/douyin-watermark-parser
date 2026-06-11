// pages/mine/index.js
Page({
  data: {
    statusBarHeight: 44,
    cacheSize: "计算中...",
    nickname: "游客",
    welcomeText: "欢迎使用解析助手 👋",
    showAbout: false,
    version: "v1.0.0",
  },

  onLoad() {
    const sysInfo = wx.getWindowInfo();
    this.setData({
      statusBarHeight: sysInfo.statusBarHeight || 44,
    });
    this.calcCacheSize();
    this.initNickname();
    this.initVersion();
  },

  // 读取小程序版本号（线上版从 miniProgram.version 取，开发版给默认值）
  initVersion() {
    try {
      const info = wx.getAccountInfoSync();
      const v = info && info.miniProgram && info.miniProgram.version;
      if (v) this.setData({ version: "v" + v });
    } catch (e) {
      // 开发版/体验版没有 version 字段，保持默认
    }
  },

  // 生成游客昵称（本地缓存一个固定数字 ID）
  initNickname() {
    let uid = wx.getStorageSync("guest_uid");
    if (!uid) {
      uid = String(Math.floor(100000 + Math.random() * 900000));
      wx.setStorageSync("guest_uid", uid);
    }
    this.setData({ nickname: "游客 " + uid });
  },

  onShow() {
    wx.setNavigationBarColor({
      frontColor: "#000000",
      backgroundColor: "#F2F0F7",
    });
  },

  // 计算缓存大小
  calcCacheSize() {
    try {
      const res = wx.getStorageInfoSync();
      const sizeKB = res.currentSize || 0;
      let label;
      if (sizeKB < 1024) {
        label = sizeKB + " KB";
      } else {
        label = (sizeKB / 1024).toFixed(1) + " MB";
      }
      this.setData({ cacheSize: label });
    } catch (e) {
      this.setData({ cacheSize: "未知" });
    }
  },

  // 权限管理
  onPermission() {
    wx.openSetting({
      fail() {
        wx.showToast({ title: "无法打开设置", icon: "none" });
      },
    });
  },

  // 清理缓存
  onClearCache() {
    wx.showModal({
      title: "清理缓存",
      content: "将清除本地缓存数据，云端数据不受影响",
      success: (res) => {
        if (res.confirm) {
          try {
            wx.clearStorageSync();
            this.setData({ cacheSize: "0 KB" });
            wx.showToast({ title: "已清理", icon: "success" });
          } catch (e) {
            wx.showToast({ title: "清理失败", icon: "none" });
          }
        }
      },
    });
  },

  // 解析历史
  onGoHistory() {
    wx.navigateTo({ url: "/pages/history/index" });
  },

  // 关于我们
  onAbout() {
    this.setData({ showAbout: true });
  },

  onCloseAbout() {
    this.setData({ showAbout: false });
  },

  // 分享
  onShareAppMessage() {
    return {
      title: "解析助手 - 轻松解析视频和图集",
      path: "/pages/index/index",
    };
  },
});
