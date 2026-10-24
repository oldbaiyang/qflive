# QFLive · 多画面直播墙

在一个屏幕里同时看多路网络直播。粘贴地址即可播放，自动识别协议，跨域被拦时自动降级走代理。

## 功能

- 支持 **HLS(.m3u8)**、**HTTP-FLV(.flv)**、**MPEG-TS(.ts)**、**DASH(.mpd)**、**MP4**
- 布局 1 / 2 / 4 / 6 / 9 画面，或按数量自动排布
- 单画面操作：静音、独奏（只留这一路声音）、全屏、重载、移除
- 断流自动重连，卡死自动拉起
- 源列表可拖动排序、双击改名，支持导入 m3u / txt / json 播放列表，导出 m3u
- 配置存在 localStorage，刷新不丢

## 目录结构

```
index.html              页面
assets/styles.css       样式
assets/app.js           界面、状态、直连→代理降级
assets/player.js        播放内核封装（协议识别 + 多内核调度）
functions/api/proxy.js  Cloudflare Pages Function：CORS 代理 + m3u8 重写
vendor/                 hls.js / mpegts.js / dash.js（本地化，不走 CDN）
_routes.json            只让 /api/* 走 Function，静态资源不消耗函数额度
```

## 本地开发

需要 Node 18+。

```bash
npm install
npm run dev          # http://localhost:8788
```

`npm run dev` 会同时启动静态资源和 Pages Function，代理可用，和线上环境一致。

> 直接双击 `index.html` 或只用 `python3 -m http.server` 也能看界面，但 `/api/proxy` 不存在，
> 跨域受限的源会播不出来（页面会提示）。

## 部署到 Cloudflare

**方式 A：Git 自动部署（推荐）**

1. 把本目录推到 GitHub 仓库
2. Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git
3. 选择仓库，构建命令留空，输出目录填 `/`
4. 保存并部署，之后每次 push 自动上线

**方式 B：命令行手动部署**

```bash
npx wrangler login
npm run deploy
```

首次会创建项目 `qflive`，完成后拿到 `https://qflive.pages.dev`。绑定自有域名在
Pages 项目的 Custom domains 里加。

## 代理是怎么工作的

浏览器直接拉 `x.m3u8` 时，若源站不放行跨域就会被拦。`/api/proxy` 做三件事：

1. 替浏览器去拉流，带上伪装的 `Referer` 和浏览器 UA（绕过常见防盗链）
2. 如果拉回来的是 m3u8，**逐行重写**里面所有 URI（分片、子清单、`#EXT-X-KEY` 密钥）
   为 `/api/proxy?url=...`，这样后续分片也走代理
3. 分片和 FLV 用流式透传，不落盘不缓冲

**为什么必须重写清单**：只代理清单、不重写内容的话，播放器解析出来的分片地址仍是源站的，
跨域照样失败——这是这类代理最常见的坑。

## 资源与限制

| 项目 | 说明 |
|---|---|
| Pages 静态请求 | 免费不限量 |
| Pages Functions | 免费 10 万次/天，超出需 Workers Paid（$5/月，1000 万次/月） |
| 请求量估算 | HLS 4 秒一个分片，1 路 1 小时 ≈ 900 次请求 |
| 端口 | Cloudflare 只能回源 80/443，源站在 `:8080` 等端口拉不到 |
| 源站封锁 | 少数国内 CDN 封 Cloudflare 回源 IP，遇到只能自建 VPS 兜底 |

前端默认**直连优先**，只有直连失败才走代理，能省掉大部分函数调用。

## 已知限制

- **RTMP / RTSP 不能播**：浏览器不支持，需要先用 ffmpeg 转成 HLS 或 FLV
- 加密流（DRM）无法播放
- 需要登录态的源不支持（代理不带 Cookie）

## 免责

本工具只做播放，不存储、不索引任何内容。请只添加你有权观看的直播源。
