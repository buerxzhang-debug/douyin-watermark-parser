// pages/index/index.js
Page({
  data: {
    statusBarHeight: 44,
    inputUrl: "",
    parsing: false,
    result: null,
    error: "",
  },

  onLoad() {
    const sysInfo = wx.getWindowInfo();
    this.setData({
      statusBarHeight: sysInfo.statusBarHeight || 44,
    });
  },

  onShow() {
    wx.setNavigationBarColor({
      frontColor: "#000000",
      backgroundColor: "#F2F0F7",
    });
  },

  onInputChange(e) {
    this.setData({ inputUrl: e.detail.value });
  },

  onClear() {
    this.setData({ inputUrl: "", result: null, error: "" });
  },

  async onPaste() {
    try {
      const res = await wx.getClipboardData();
      const text = (res.data || "").trim();
      if (!text) {
        wx.showToast({ title: "剪贴板为空", icon: "none" });
        return;
      }
      this.setData({ inputUrl: text, error: "" });
      wx.showToast({ title: "已粘贴", icon: "none", duration: 800 });
    } catch (err) {
      wx.showToast({ title: "粘贴失败", icon: "none" });
    }
  },

  async onParse() {
    const { inputUrl } = this.data;
    if (!inputUrl.trim()) {
      wx.showToast({ title: "请输入分享链接", icon: "none" });
      return;
    }

    const app = getApp();
    if (!app.globalData.env) {
      wx.showModal({
        title: "提示",
        content: "请先在 app.js 中配置云开发环境 ID",
      });
      return;
    }

    this.setData({ parsing: true, result: null, error: "" });

    try {
      const res = await wx.cloud.callFunction({
        name: "parseWatermark",
        data: { url: inputUrl.trim() },
      });

      const r = res.result || {};

      if (r.success) {
        this.setData({ result: r.data, parsing: false });

        // 统一提示解析成功
        wx.showToast({ title: "解析成功", icon: "success", duration: 1500 });

        // 标记历史页需要刷新
        if (app.globalData) app.globalData.historyDirty = true;
      } else {
        // 限频、平台不支持、解析失败等，统一展示云函数返回的 message
        this.setData({
          error: r.message || "解析失败，请稍后重试",
          parsing: false,
        });
      }
    } catch (e) {
      console.error("解析失败:", e);
      let errMsg = "解析失败";
      if (e.errMsg && e.errMsg.includes("FunctionName parameter could not be found")) {
        errMsg = "云函数未部署，请先上传 parseWatermark";
      } else if (e.errMsg && e.errMsg.includes("Environment not found")) {
        errMsg = "云开发环境未找到，请检查配置";
      }
      this.setData({ error: errMsg, parsing: false });
    }
  },

  onPreviewImage(e) {
    const { url } = e.currentTarget.dataset;
    const { result } = this.data;
    let urls = [url];
    if (result && result.resources) {
      urls = result.resources.map((r) => r.fileID);
    }
    wx.previewImage({ current: url, urls });
  },

  /** 预览封面大图 */
  onPreviewCover(e) {
    const { url } = e.currentTarget.dataset;
    if (url) wx.previewImage({ current: url, urls: [url] });
  },

  // 请求相册写入权限
  async _ensureAlbumAuth() {
    try {
      await wx.authorize({ scope: "scope.writePhotosAlbum" });
      return true;
    } catch (err) {
      const res = await wx.showModal({
        title: "需要授权",
        content: "保存到相册需要您授权相册权限，请在设置中开启",
        confirmText: "去设置",
      });
      if (res.confirm) wx.openSetting();
      return false;
    }
  },

  async onSaveVideo(e) {
    const { fileId } = e.currentTarget.dataset;
    const authed = await this._ensureAlbumAuth();
    if (!authed) return;

    wx.showLoading({ title: "保存中..." });
    try {
      const res = await wx.cloud.downloadFile({ fileID: fileId });
      await wx.saveVideoToPhotosAlbum({ filePath: res.tempFilePath });
      wx.hideLoading();
      wx.showToast({ title: "已保存到相册", icon: "success" });
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: "保存失败", icon: "none" });
    }
  },

  async onSaveAllImages() {
    const { result } = this.data;
    if (!result || result.type !== "note" || !result.resources) return;

    const authed = await this._ensureAlbumAuth();
    if (!authed) return;

    const total = result.resources.length;
    wx.showLoading({ title: "保存中 0/" + total });
    let saved = 0;
    // 并发限制 3：避免一次性发起 20 个下载导致小程序卡顿
    const CONCURRENCY = 3;
    let cursor = 0;
    const worker = async () => {
      while (cursor < total) {
        const i = cursor++;
        try {
          const res = await wx.cloud.downloadFile({ fileID: result.resources[i].fileID });
          await wx.saveImageToPhotosAlbum({ filePath: res.tempFilePath });
          saved++;
          wx.showLoading({ title: `保存中 ${saved}/${total}` });
        } catch (err) {
          console.error(`保存第 ${i + 1} 张失败:`, err);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker())
    );
    wx.hideLoading();
    wx.showToast({
      title: `已保存 ${saved} 张`,
      icon: saved > 0 ? "success" : "none",
    });
  },

});
