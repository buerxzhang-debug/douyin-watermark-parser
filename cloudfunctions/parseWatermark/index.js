/**
 * 云函数 parseWatermark
 *
 * 功能：
 * 1. 接收客户端传入的抖音分享链接
 * 2. 解析短链 → 获取内容详情（视频/图文）
 * 3. 通过 axios 下载资源文件（视频/图片）
 * 4. 上传至云存储（使用 buffer）
 * 5. 将记录写入数据库 parse_records
 * 6. 返回云存储 fileID 给客户端
 */

const cloud = require("wx-server-sdk");
const axios = require("axios");
const https = require("https");
const http = require("http");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// ==================== HTTP 工具 ====================

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";

/**
 * 发起 HTTP 请求（不跟踪重定向）
 */
function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const client = urlObj.protocol === "https:" ? https : http;
    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: options.method || "GET",
      headers: { "User-Agent": MOBILE_UA, ...options.headers },
    };
    const req = client.request(reqOptions, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () =>
        resolve({ statusCode: res.statusCode, headers: res.headers, body: data })
      );
    });
    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error("请求超时"));
    });
    req.end();
  });
}

/**
 * 跟踪重定向，返回最终 URL
 */
async function followRedirects(url, maxRedirects = 10) {
  let currentUrl = url;
  for (let i = 0; i < maxRedirects; i++) {
    const res = await httpRequest(currentUrl);
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      const loc = res.headers.location;
      currentUrl = loc.startsWith("http") ? loc : new URL(loc, currentUrl).toString();
    } else {
      return { url: currentUrl, response: res };
    }
  }
  return { url: currentUrl, response: null };
}

// ==================== 解析逻辑 ====================

/** 从文本中提取抖音链接 */
function extractShareUrl(text) {
  const shortMatch = text.match(/https?:\/\/v\.douyin\.com\/[A-Za-z0-9_\-]+\/?/);
  if (shortMatch) return shortMatch[0];
  const videoMatch = text.match(/https?:\/\/www\.douyin\.com\/video\/(\d+)/);
  if (videoMatch) return videoMatch[0];
  const noteMatch = text.match(/https?:\/\/www\.douyin\.com\/note\/(\d+)/);
  if (noteMatch) return noteMatch[0];
  const iesVideo = text.match(/https?:\/\/www\.iesdouyin\.com\/share\/video\/(\d+)/);
  if (iesVideo) return iesVideo[0];
  const iesNote = text.match(/https?:\/\/www\.iesdouyin\.com\/share\/note\/(\d+)/);
  if (iesNote) return iesNote[0];
  return null;
}

/** 检测不支持的平台，返回平台名（用于友好提示） */
function detectUnsupportedPlatform(text) {
  const platforms = [
    { pattern: /kuaishou\.com|v\.kuaishou|gifshow\.com|chenzhongtech\.com/i, name: "快手" },
    { pattern: /xiaohongshu\.com|xhslink\.com/i, name: "小红书" },
    { pattern: /bilibili\.com|b23\.tv/i, name: "B站" },
    { pattern: /weishi\.qq\.com/i, name: "微视" },
    { pattern: /pipix\.com|pipigx\.com/i, name: "皮皮虾" },
    { pattern: /weibo\.com|weibo\.cn|t\.cn/i, name: "微博" },
    { pattern: /youtube\.com|youtu\.be/i, name: "YouTube" },
    { pattern: /instagram\.com/i, name: "Instagram" },
    { pattern: /tiktok\.com/i, name: "TikTok" },
    { pattern: /twitter\.com|x\.com/i, name: "X(Twitter)" },
    { pattern: /facebook\.com|fb\.watch/i, name: "Facebook" },
    { pattern: /ixigua\.com/i, name: "西瓜视频" },
    { pattern: /zuiyou\.com/i, name: "最右" },
  ];
  for (const { pattern, name } of platforms) {
    if (pattern.test(text)) return name;
  }
  return null;
}

/** 从 URL 提取内容 ID 和类型 */
function extractContentInfo(url) {
  const noteMatch = url.match(/\/note\/(\d+)/);
  if (noteMatch) return { awemeId: noteMatch[1], type: "note" };
  const videoMatch = url.match(/\/video\/(\d+)/);
  if (videoMatch) return { awemeId: videoMatch[1], type: "video" };
  return null;
}

/** 解析短链获取 awemeId 和类型 */
async function resolveShortUrl(shortUrl) {
  const { url: realUrl } = await followRedirects(shortUrl);
  const info = extractContentInfo(realUrl);
  if (!info) throw new Error("无法从链接中提取内容 ID");
  return info;
}

/** 获取视频详情 */
async function fetchVideoInfo(awemeId) {
  const shareUrl = `https://www.iesdouyin.com/share/video/${awemeId}/`;
  const res = await httpRequest(shareUrl, {
    headers: { Referer: "https://www.douyin.com/" },
  });
  if (res.statusCode !== 200) throw new Error(`请求视频页面失败: ${res.statusCode}`);

  const html = res.body;

  // 优先 _ROUTER_DATA
  const routerMatch = html.match(/window\._ROUTER_DATA\s*=\s*({.+?})\s*<\/script>/s);
  if (routerMatch) {
    try {
      const data = JSON.parse(routerMatch[1]);
      const pageKey = Object.keys(data.loaderData || {}).find(
        (k) => k.includes("video") && k.includes("page")
      );
      if (pageKey) {
        const item = data.loaderData[pageKey]?.videoInfoRes?.item_list?.[0];
        if (item && item.video?.vid) {
          // 提取高清封面 URL（优先 origin_cover，fallback cover）
          const coverUrls =
            item.video?.origin_cover?.url_list ||
            item.video?.cover?.url_list ||
            [];
          return {
            videoId: item.video.vid,
            desc: item.desc || "",
            author: item.author?.nickname || "",
            ratio: item.video.ratio || "720p",
            statistics: item.statistics || {},
            coverUrl: coverUrls[0] || "",
          };
        }
      }
      console.warn("[fetchVideoInfo] _ROUTER_DATA 结构变化，进入正则降级");
    } catch (e) {
      console.warn("[fetchVideoInfo] _ROUTER_DATA JSON 解析失败，进入正则降级:", e.message);
    }
  } else {
    console.warn("[fetchVideoInfo] 未找到 _ROUTER_DATA，进入正则降级");
  }

  // 回退正则（_ROUTER_DATA 不存在或字段变更时的兜底方案）
  const vidMatch = html.match(/video_id=([a-zA-Z0-9_]+)/) || html.match(/"vid"\s*:\s*"([a-zA-Z0-9_]+)"/);
  if (!vidMatch) throw new Error("解析失败：抖音页面结构可能已更新");

  let desc = "";
  const descMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (descMatch) desc = descMatch[1].replace(/\s*-\s*抖音$/, "").trim();

  const ratioMatch = html.match(/ratio=(\d+p)/) || html.match(/"ratio"\s*:\s*"(\d+p)"/);
  // 兜底封面：尝试从 og:image 取
  let coverUrl = "";
  const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  if (ogImage) coverUrl = ogImage[1];

  return {
    videoId: vidMatch[1],
    desc,
    author: "",
    ratio: ratioMatch ? ratioMatch[1] : "720p",
    statistics: {},
    coverUrl,
  };
}

/** 获取无水印视频 CDN 地址 */
async function getVideoUrl(videoId, ratio = "720p") {
  const noWmUrl = `https://aweme.snssdk.com/aweme/v1/play/?video_id=${videoId}&ratio=${ratio}&line=0`;
  const res = await httpRequest(noWmUrl);
  if ([301, 302].includes(res.statusCode) && res.headers.location) {
    return res.headers.location;
  }
  return noWmUrl;
}

/** 获取图文详情 */
async function fetchNoteInfo(awemeId) {
  const shareUrl = `https://www.iesdouyin.com/share/note/${awemeId}/`;
  const res = await httpRequest(shareUrl, {
    headers: { Referer: "https://www.douyin.com/" },
  });
  if (res.statusCode !== 200) throw new Error(`请求图文页面失败: ${res.statusCode}`);

  const html = res.body;
  const routerMatch = html.match(/window\._ROUTER_DATA\s*=\s*({.+?})\s*<\/script>/s);
  if (!routerMatch) throw new Error("无法解析图文页面数据");

  const data = JSON.parse(routerMatch[1]);
  const noteKey = Object.keys(data.loaderData).find(
    (k) => k.includes("note") && k.includes("page")
  );
  if (!noteKey) throw new Error("无法定位图文数据");

  const item = data.loaderData[noteKey]?.videoInfoRes?.item_list?.[0];
  if (!item) throw new Error("无法获取图文详情");

  const images = (item.images || []).map((img, i) => {
    const urls = img.url_list || [];
    return {
      index: i,
      width: img.width,
      height: img.height,
      url: urls[0] || "",
    };
  });

  if (images.length === 0) throw new Error("未找到图片");

  return {
    desc: item.desc || "",
    author: item.author?.nickname || "",
    images,
    statistics: item.statistics || {},
  };
}

// ==================== 下载 & 上传 ====================

/**
 * 根据 Content-Type 推断文件扩展名
 */
function getExtFromContentType(contentType, hint = "") {
  const mimeMap = {
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/heif": "heif",
    "image/avif": "avif",
  };
  const ct = (contentType || "").toLowerCase();
  for (const [mime, ext] of Object.entries(mimeMap)) {
    if (ct.includes(mime)) return ext;
  }
  // fallback：从 hint 或 URL 中猜测
  if (hint.includes("video") || hint.includes(".mp4")) return "mp4";
  if (hint.includes(".jpg") || hint.includes(".jpeg")) return "jpg";
  if (hint.includes(".png")) return "png";
  return "webp";
}

/**
 * 用 axios 下载资源 → Buffer → 上传到云存储
 *
 * @param {string} url 资源远程地址
 * @param {string} cloudPathBase 云存储路径（不含扩展名）
 * @param {string} [hintExt] 可选：强制指定扩展名
 * @returns {{ fileID: string, size: number, contentType: string }}
 */
async function downloadAndUpload(url, cloudPathBase, hintExt) {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 60000,
    maxRedirects: 10,
    headers: { "User-Agent": MOBILE_UA },
  });

  const buffer = Buffer.from(response.data);
  const contentType = response.headers["content-type"] || "";

  // 确定扩展名：优先用明确指定的，其次从 Content-Type 推断
  const ext = hintExt || getExtFromContentType(contentType, url);
  const cloudPath = `${cloudPathBase}.${ext}`;

  const uploadRes = await cloud.uploadFile({
    cloudPath,
    fileContent: buffer,
  });

  return {
    fileID: uploadRes.fileID,
    size: buffer.length,
    contentType,
  };
}

/**
 * 并发限制器：最多同时执行 limit 个任务
 * 防止图文 20+ 张图片同时下载上传打爆内存
 */
async function parallelWithLimit(taskFns, limit = 3) {
  const results = new Array(taskFns.length);
  let index = 0;

  async function worker() {
    while (index < taskFns.length) {
      const i = index++;
      results[i] = await taskFns[i]();
    }
  }

  // 启动 limit 个 worker 并行消费
  const workers = Array.from({ length: Math.min(limit, taskFns.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ==================== 删除记录 ====================

/**
 * 过滤掉被其他记录引用的 fileID（避免删除克隆缓存指向的共享文件）
 *
 * 实现思路：直接在数据库里反查每个 fileID 是否被其他记录的 resources/coverUrl 引用，
 * 若被引用则跳过删除。注意 _id 数组排除当前要删的记录（支持单条/批量）
 */
async function filterDeletableFileIDs(fileIDs, excludeRecordIds) {
  if (!fileIDs || fileIDs.length === 0) return [];
  const _ = db.command;
  const deletable = [];
  for (const fileID of fileIDs) {
    try {
      const { total } = await db
        .collection("parse_records")
        .where(
          _.and([
            { _id: _.nin(excludeRecordIds) },
            _.or([
              { "resources.fileID": fileID },
              { coverUrl: fileID },
            ]),
          ])
        )
        .count();
      if (total === 0) deletable.push(fileID);
    } catch (err) {
      // 反查失败时保守处理：不删，避免误删共享文件
      console.warn("filterDeletableFileIDs 查询失败，保守跳过删除:", fileID, err);
    }
  }
  return deletable;
}

/**
 * 删除记录：同时删除数据库记录和云存储文件
 * 云函数拥有管理员权限，可以可靠地删除云存储文件
 *
 * 注意：findAndCloneCache 会让多条记录共享同一组 fileID，
 * 删除前必须排除"还被其他记录引用"的文件，否则会误删共享资源。
 */
async function deleteRecord(event) {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const { recordId } = event;

  if (!recordId) {
    return { success: false, message: "缺少记录 ID" };
  }

  try {
    // 1. 先查出记录（确保是当前用户的）
    const record = await db.collection("parse_records").doc(recordId).get();
    if (!record.data) {
      return { success: false, message: "记录不存在" };
    }
    if (record.data._openid !== openid) {
      return { success: false, message: "无权删除此记录" };
    }

    // 2. 收集所有云存储文件 ID（包括封面）
    const fileIDs = (record.data.resources || [])
      .map((r) => r.fileID)
      .filter(Boolean);
    if (record.data.coverUrl) {
      fileIDs.push(record.data.coverUrl);
    }

    // 3. 过滤：只删除"未被其他记录引用"的文件
    const deletable = await filterDeletableFileIDs(fileIDs, [recordId]);

    // 4. 删除云存储文件（管理员权限，100% 生效）
    if (deletable.length > 0) {
      const deleteResult = await cloud.deleteFile({ fileList: deletable });
      console.log("云存储删除结果:", JSON.stringify(deleteResult));
    }

    // 5. 删除数据库记录
    await db.collection("parse_records").doc(recordId).remove();

    return {
      success: true,
      deletedFiles: deletable.length,
      skippedShared: fileIDs.length - deletable.length,
    };
  } catch (err) {
    console.error("删除记录失败:", err);
    return { success: false, message: err.message || "删除失败" };
  }
}

// ==================== 删除全部记录 ====================

/**
 * 删除当前用户所有记录和对应的云存储文件
 *
 * 注意：跨用户缓存克隆会共享 fileID，所以删除前要把"被其他用户记录引用"的文件
 * 过滤掉。先收集所有 fileID + recordId，删完数据库后再反查决定哪些可删。
 */
async function deleteAllRecords() {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  try {
    // 分批查询所有记录（每次最多 100 条）
    let allFileIDs = [];
    let allRecordIds = [];
    let hasMore = true;

    while (hasMore) {
      const res = await db
        .collection("parse_records")
        .where({ _openid: openid })
        .limit(100)
        .field({ _id: true, resources: true, coverUrl: true })
        .get();

      if (res.data.length === 0) {
        hasMore = false;
        break;
      }

      for (const record of res.data) {
        allRecordIds.push(record._id);
        (record.resources || []).forEach((r) => {
          if (r.fileID) allFileIDs.push(r.fileID);
        });
        if (record.coverUrl) allFileIDs.push(record.coverUrl);
      }

      // 逐条删除数据库记录
      for (const id of res.data.map((r) => r._id)) {
        await db.collection("parse_records").doc(id).remove();
      }

      if (res.data.length < 100) hasMore = false;
    }

    // 去重
    const uniqueFileIDs = Array.from(new Set(allFileIDs));
    // 过滤：只删除"未被其他记录引用"的文件（数据库记录已删，所以排除 [] 即可，
    // 但稳妥起见仍然显式排除已删除的 recordIds 防御未来逻辑变化）
    const deletable = await filterDeletableFileIDs(uniqueFileIDs, allRecordIds);

    // 批量删除云存储文件（每次最多 50 个）
    for (let i = 0; i < deletable.length; i += 50) {
      const batch = deletable.slice(i, i + 50);
      await cloud.deleteFile({ fileList: batch });
    }

    return {
      success: true,
      deletedRecords: allRecordIds.length,
      deletedFiles: deletable.length,
      skippedShared: uniqueFileIDs.length - deletable.length,
    };
  } catch (err) {
    console.error("删除全部记录失败:", err);
    return { success: false, message: err.message || "删除失败" };
  }
}

// ==================== 限频 & 缓存 ====================

/** 每分钟最大解析次数 */
const RATE_LIMIT_PER_MINUTE = 2;

/**
 * 检查用户请求频率（1 分钟内不超过 RATE_LIMIT_PER_MINUTE 次）
 * 返回 { allowed, remaining, retryAfterSec }
 */
async function checkRateLimit(openid) {
  const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
  const { total } = await db
    .collection("parse_records")
    .where({
      _openid: openid,
      createTime: db.command.gte(oneMinuteAgo),
    })
    .count();

  if (total >= RATE_LIMIT_PER_MINUTE) {
    // 查最早那条的时间，算出还要等多久
    const { data } = await db
      .collection("parse_records")
      .where({
        _openid: openid,
        createTime: db.command.gte(oneMinuteAgo),
      })
      .orderBy("createTime", "asc")
      .limit(1)
      .field({ createTime: true })
      .get();

    let retryAfterSec = 60;
    if (data.length > 0 && data[0].createTime) {
      const earliest = new Date(data[0].createTime).getTime();
      retryAfterSec = Math.max(1, Math.ceil((earliest + 60000 - Date.now()) / 1000));
    }

    return { allowed: false, remaining: 0, retryAfterSec };
  }

  return { allowed: true, remaining: RATE_LIMIT_PER_MINUTE - total - 1, retryAfterSec: 0 };
}

/**
 * 查找已有的解析缓存（任何用户解析过的同一 awemeId）
 * 找到后为当前用户复制一条新记录（数据库权限隔离）
 */
async function findAndCloneCache(awemeId, openid) {
  // 先查当前用户自己有没有（最常见的命中场景）
  const own = await db
    .collection("parse_records")
    .where({ _openid: openid, awemeId })
    .orderBy("createTime", "desc")
    .limit(1)
    .get();

  if (own.data.length > 0) {
    const cached = own.data[0];
    return {
      type: cached.type,
      desc: cached.desc,
      author: cached.author,
      coverUrl: cached.coverUrl || "",
      resources: cached.resources,
    };
  }

  // 再查全局（用云函数管理员权限，不受 openid 隔离）
  const global = await db
    .collection("parse_records")
    .where({ awemeId })
    .orderBy("createTime", "desc")
    .limit(1)
    .get();

  if (global.data.length > 0) {
    const cached = global.data[0];
    // 为当前用户克隆一条记录
    const cloned = {
      _openid: openid,
      type: cached.type,
      awemeId: cached.awemeId,
      desc: cached.desc,
      author: cached.author,
      coverUrl: cached.coverUrl || "",
      resources: cached.resources,
      createTime: db.serverDate(),
      createTimeStr: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
      clonedFrom: cached._id, // 标记来源
    };
    await db.collection("parse_records").add({ data: cloned });

    return {
      type: cached.type,
      desc: cached.desc,
      author: cached.author,
      coverUrl: cached.coverUrl || "",
      resources: cached.resources,
    };
  }

  return null;
}

// ==================== 主入口 ====================

exports.main = async (event, context) => {
  // 路由：根据 action 分发不同功能
  if (event.action === "delete") {
    return deleteRecord(event);
  }

  if (event.action === "deleteAll") {
    return deleteAllRecords();
  }

  const { url: inputUrl } = event;
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  if (!inputUrl) {
    return { success: false, message: "请输入链接" };
  }

  try {
    // 1. 提取链接
    const shareUrl = extractShareUrl(inputUrl);
    if (!shareUrl) {
      const platform = detectUnsupportedPlatform(inputUrl);
      if (platform) {
        return { success: false, message: `暂不支持${platform}，敬请期待` };
      }
      return { success: false, message: "未识别到有效链接，请检查后重试" };
    }

    // 2. 解析类型和 awemeId
    let awemeId, contentType;
    const directInfo = extractContentInfo(shareUrl);
    if (directInfo) {
      awemeId = directInfo.awemeId;
      contentType = directInfo.type;
    } else {
      const resolved = await resolveShortUrl(shareUrl);
      awemeId = resolved.awemeId;
      contentType = resolved.type;
    }

    // 3. 限频检查（先查限频，再查缓存——防止用户用同链接刷接口绕过限频）
    const rateCheck = await checkRateLimit(openid);
    if (!rateCheck.allowed) {
      return {
        success: false,
        message: `操作太频繁，请 ${rateCheck.retryAfterSec} 秒后再试`,
        retryAfterSec: rateCheck.retryAfterSec,
        rateLimited: true,
      };
    }

    // 4. 缓存命中：同一内容已被解析过，直接复用（不请求抖音）
    const cached = await findAndCloneCache(awemeId, openid);
    if (cached) {
      return {
        success: true,
        data: cached,
        fromCache: true, // 告诉客户端这是缓存结果
      };
    }

    // 5. 正式解析
    const timestamp = Date.now();
    let result;

    if (contentType === "video") {
      // ===== 视频处理 =====
      const info = await fetchVideoInfo(awemeId);
      const cdnUrl = await getVideoUrl(info.videoId, info.ratio);

      // 并行下载：视频 + 封面
      const videoCloudBase = `watermark/${openid}/videos/video_${awemeId}_${timestamp}`;
      const coverCloudBase = `watermark/${openid}/covers/cover_${awemeId}_${timestamp}`;

      const downloadTasks = [
        downloadAndUpload(cdnUrl, videoCloudBase, "mp4"),
      ];
      // 有封面 URL 才下载
      if (info.coverUrl) {
        downloadTasks.push(downloadAndUpload(info.coverUrl, coverCloudBase));
      }

      const [uploadResult, coverUpload] = await Promise.all(downloadTasks);
      const coverFileID = coverUpload ? coverUpload.fileID : "";

      const record = {
        _openid: openid,
        type: "video",
        awemeId,
        desc: info.desc,
        author: info.author,
        coverUrl: coverFileID,
        resources: [{
          fileID: uploadResult.fileID,
          size: uploadResult.size,
          contentType: uploadResult.contentType,
          width: 0,
          height: 0,
        }],
        createTime: db.serverDate(),
        createTimeStr: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
      };

      await db.collection("parse_records").add({ data: record });

      result = {
        type: "video",
        desc: info.desc,
        author: info.author,
        coverUrl: coverFileID,
        resources: record.resources,
      };
    } else {
      // ===== 图文处理 =====
      const info = await fetchNoteInfo(awemeId);

      const taskFns = info.images.map((img) => {
        return async () => {
          const cloudBase = `watermark/${openid}/images/note_${awemeId}_${timestamp}_${img.index}`;
          const uploadResult = await downloadAndUpload(img.url, cloudBase);
          return {
            fileID: uploadResult.fileID,
            size: uploadResult.size,
            contentType: uploadResult.contentType,
            width: img.width,
            height: img.height,
          };
        };
      });

      const resources = await parallelWithLimit(taskFns, 3);

      const record = {
        _openid: openid,
        type: "note",
        awemeId,
        desc: info.desc,
        author: info.author,
        coverUrl: resources[0]?.fileID || "",
        resources,
        createTime: db.serverDate(),
        createTimeStr: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
      };

      await db.collection("parse_records").add({ data: record });

      result = {
        type: "note",
        desc: info.desc,
        author: info.author,
        coverUrl: resources[0]?.fileID || "",
        resources,
      };
    }

    return {
      success: true,
      data: result,
      remaining: rateCheck.remaining, // 告诉客户端还剩几次
    };
  } catch (err) {
    console.error("解析失败:", err);
    return { success: false, message: err.message || "解析失败，请稍后重试" };
  }
};
