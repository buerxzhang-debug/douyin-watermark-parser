// pages/history/index.js
const db = wx.cloud.database();

Page({
  data: {
    statusBarHeight: 44,
    records: [],
    loading: false,
    hasMore: true,
    page: 0,
    pageSize: 20,
    isEmpty: false,
    totalCount: 0,
  },

  // 实例字段（避免模块级变量在冷启动时复用脏数据）
  _loaded: false,

  onLoad() {
    const sysInfo = wx.getWindowInfo();
    this.setData({
      statusBarHeight: sysInfo.statusBarHeight || 44,
    });
  },

  onGoBack() {
    wx.navigateBack();
  },

  onShow() {
    const app = getApp();
    wx.setNavigationBarColor({
      frontColor: "#000000",
      backgroundColor: "#F2F0F7",
    });
    // 首次进入 或 有新数据时才刷新
    if (!this._loaded || (app.globalData && app.globalData.historyDirty)) {
      this.refresh();
      this._loaded = true;
      if (app.globalData) app.globalData.historyDirty = false;
    }
  },

  async onPullDownRefresh() {
    await this.refresh();
    wx.stopPullDownRefresh();
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      this.loadMore();
    }
  },

  async refresh() {
    this.setData({ page: 0, records: [], hasMore: true, isEmpty: false });
    // 查总条数
    try {
      const countRes = await db.collection("parse_records").count();
      this.setData({ totalCount: countRes.total || 0 });
    } catch (e) {
      this.setData({ totalCount: 0 });
    }
    await this.loadMore();
  },

  async loadMore() {
    if (this.data.loading) return;
    this.setData({ loading: true });

    try {
      const { page, pageSize, records } = this.data;
      const res = await db
        .collection("parse_records")
        .orderBy("createTime", "desc")
        .skip(page * pageSize)
        .limit(pageSize)
        .get();

      // 收集所有图文资源的 fileID，批量获取临时 HTTPS URL（用于拼接缩略图参数）
      const allImageFileIDs = [];
      res.data.forEach((item) => {
        if (item.type === "note") {
          (item.resources || []).forEach((r) => {
            if (r.fileID) allImageFileIDs.push(r.fileID);
          });
        }
      });

      // 批量获取临时 URL（一次最多 50 个）
      let fileIdToUrl = {};
      if (allImageFileIDs.length > 0) {
        try {
          const urlRes = await wx.cloud.getTempFileURL({ fileList: allImageFileIDs });
          (urlRes.fileList || []).forEach((f) => {
            if (f.tempFileURL) fileIdToUrl[f.fileID] = f.tempFileURL;
          });
        } catch (err) {
          console.warn("getTempFileURL 失败，缩略图降级为原图:", err);
        }
      }

      const processed = res.data.map((item) => {
        const fileIDs = (item.resources || []).map((r) => r.fileID);
        item.resourceFileIDs = fileIDs.join(",");
        // 为每个图片资源生成缩略图 URL（拼接数据万象参数，宽度限制 200px）
        if (item.type === "note") {
          item.resources = (item.resources || []).map((r) => ({
            ...r,
            thumbURL: fileIdToUrl[r.fileID]
              ? fileIdToUrl[r.fileID] + "?imageMogr2/thumbnail/200x"
              : r.fileID,
          }));
        }
        if (item.createTime) {
          const d = new Date(item.createTime);
          const pad = (n) => String(n).padStart(2, "0");
          item.createTimeStr = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        }
        return item;
      });

      const newRecords = records.concat(processed);
      this.setData({
        records: newRecords,
        page: page + 1,
        hasMore: res.data.length === pageSize,
        loading: false,
        isEmpty: newRecords.length === 0,
      });
    } catch (e) {
      console.error("加载历史记录失败:", e);
      this.setData({ loading: false });
      if (e.errCode !== -502005) {
        wx.showToast({ title: "加载失败", icon: "none" });
      } else {
        this.setData({ isEmpty: true });
      }
    }
  },

  onPreviewImage(e) {
    const { url, urls } = e.currentTarget.dataset;
    wx.previewImage({
      current: url,
      urls: urls ? urls.split(",") : [url],
    });
  },

  onPlayVideo(e) {
    const { id } = e.currentTarget.dataset;
    const records = this.data.records.map((r) =>
      r._id === id ? { ...r, _playing: true } : { ...r, _playing: false }
    );
    this.setData({ records });
  },

  async onDelete(e) {
    const { id } = e.currentTarget.dataset;
    const res = await wx.showModal({
      title: "确认删除",
      content: "删除后数据不可恢复，是否继续？",
    });
    if (!res.confirm) return;

    wx.showLoading({ title: "删除中..." });
    try {
      // 调用云函数删除（管理员权限，可靠删除云存储文件）
      const cloudRes = await wx.cloud.callFunction({
        name: "parseWatermark",
        data: { action: "delete", recordId: id },
      });

      if (cloudRes.result && cloudRes.result.success) {
        const records = this.data.records.filter((r) => r._id !== id);
        this.setData({
          records,
          isEmpty: records.length === 0,
          totalCount: Math.max(0, this.data.totalCount - 1),
        });
        wx.hideLoading();
        wx.showToast({ title: "已删除", icon: "success" });
      } else {
        wx.hideLoading();
        wx.showToast({
          title: cloudRes.result?.message || "删除失败",
          icon: "none",
        });
      }
    } catch (e) {
      wx.hideLoading();
      console.error("删除失败:", e);
      wx.showToast({ title: "删除失败", icon: "none" });
    }
  },

  async onDeleteAll() {
    const { totalCount } = this.data;
    if (totalCount === 0) return;
    const res = await wx.showModal({
      title: "删除全部",
      content: `确定删除全部 ${totalCount} 条记录？此操作不可恢复！`,
      confirmColor: "#e74c3c",
    });
    if (!res.confirm) return;

    wx.showLoading({ title: "删除中..." });
    try {
      const cloudRes = await wx.cloud.callFunction({
        name: "parseWatermark",
        data: { action: "deleteAll" },
      });
      wx.hideLoading();
      if (cloudRes.result && cloudRes.result.success) {
        this.setData({
          records: [],
          isEmpty: true,
          totalCount: 0,
        });
        wx.showToast({ title: "已全部删除", icon: "success" });
      } else {
        wx.showToast({ title: cloudRes.result?.message || "删除失败", icon: "none" });
      }
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: "删除失败", icon: "none" });
    }
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

  async onSaveToLocal(e) {
    const { type, resources } = e.currentTarget.dataset;
    if (!resources) {
      wx.showToast({ title: "无资源可保存", icon: "none" });
      return;
    }
    const fileIDs = resources.split(",").filter(Boolean);
    if (fileIDs.length === 0) {
      wx.showToast({ title: "无资源可保存", icon: "none" });
      return;
    }

    const authed = await this._ensureAlbumAuth();
    if (!authed) return;

    if (type === "video") {
      wx.showLoading({ title: "保存中..." });
      try {
        const res = await wx.cloud.downloadFile({ fileID: fileIDs[0] });
        await wx.saveVideoToPhotosAlbum({ filePath: res.tempFilePath });
        wx.hideLoading();
        wx.showToast({ title: "已保存到相册", icon: "success" });
      } catch (err) {
        wx.hideLoading();
        wx.showToast({ title: "保存失败", icon: "none" });
      }
    } else {
      wx.showLoading({ title: "保存中 0/" + fileIDs.length });
      let saved = 0;
      // 并发限制 3：避免同时下载过多导致小程序网络抖动
      const CONCURRENCY = 3;
      let cursor = 0;
      const worker = async () => {
        while (cursor < fileIDs.length) {
          const i = cursor++;
          try {
            const res = await wx.cloud.downloadFile({ fileID: fileIDs[i] });
            await wx.saveImageToPhotosAlbum({ filePath: res.tempFilePath });
            saved++;
            wx.showLoading({ title: `保存中 ${saved}/${fileIDs.length}` });
          } catch (err) {
            console.error(`保存第 ${i + 1} 张失败:`, err);
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, fileIDs.length) }, () => worker())
      );
      wx.hideLoading();
      wx.showToast({
        title: `已保存 ${saved} 张`,
        icon: saved > 0 ? "success" : "none",
      });
    }
  },
});
