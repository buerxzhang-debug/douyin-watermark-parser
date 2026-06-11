# 抖音去水印解析助手 🎬

> 基于微信小程序 + 云开发的抖音视频/图文去水印解析工具

## 功能特性

- 🔗 **链接解析** — 支持抖音短链、视频链接、图文链接自动识别
- 🎥 **去水印视频** — 解析无水印版视频，在线播放 + 保存到相册
- 🖼️ **图集解析** — 支持多图图文下载，宫格预览 + 全部保存
- 📋 **历史记录** — 分页展示解析记录，支持播放、保存、删除
- ⚡ **智能缓存** — 同一内容自动复用缓存，解析更快
- 🔒 **限频保护** — 防止频繁调用，保障云函数稳定

## 项目结构

```
├── cloudfunctions/
│   └── parseWatermark/        # 去水印解析云函数
│       ├── index.js           # 主逻辑（短链追踪、视频/图文解析、限频缓存）
│       ├── package.json
│       └── config.json
├── miniprogram/
│   ├── app.js
│   ├── app.json / app.wxss
│   ├── config.example.js      # 云环境 ID 配置模板（部署时复制为 config.js）
│   ├── components/
│   │   └── privacy-popup/     # 隐私合规弹窗组件
│   ├── images/
│   │   └── tabbar/            # 底部导航图标
│   └── pages/
│       ├── index/             # 首页（输入解析、结果展示）
│       ├── history/           # 历史记录列表
│       └── mine/              # 个人中心
└── project.config.json        # 小程序项目配置
```

## 快速开始

### 前置条件

1. 注册 [微信小程序](https://mp.weixin.qq.com/) 并获取 AppID
2. 开通 [云开发](https://developers.weixin.qq.com/miniprogram/dev/wxcloud/basis/getting-started.html)

### 部署步骤

1. **克隆项目**
   ```bash
   git clone git@github.com:buerxzhang-debug/douyin-watermark-parser.git
   ```

2. **配置云环境 ID**
   ```bash
   cp miniprogram/config.example.js miniprogram/config.js
   ```
   编辑 `miniprogram/config.js`，将 `CLOUD_ENV` 改为你的云环境 ID

3. **上传云函数**
   ```bash
   # 或通过小程序开发者工具右键上传
   ./uploadCloudFunction.sh
   ```

4. **创建数据库集合**
   - 在云开发控制台创建集合 `parse_records`
   - 权限设置为"所有用户可读，仅创建者可读写"

5. **打开开发者工具**
   - 导入项目，填入 AppID
   - 在 `project.config.json` 中确认 `appid` 配置正确

## 技术栈

- **前端**: 微信小程序原生开发
- **后端**: 微信云开发（云函数 + 云数据库 + 云存储）
- **依赖**: `wx-server-sdk`、`axios`

## 注意事项

- 抖音链接解析基于页面 HTML 爬取，如抖音更新页面结构可能需要适配
- 云函数超时时间建议设置为 60s 以上
- 云存储文件会占用空间，建议定期在控制台清理

## License

MIT
