# Clear Glass · Meting Bridge

把 `@eldment/meting-agent@1.6.11` 的 **MCP stdio** 服务包装成网站可调用的 HTTPS JSON API。仅启用 `netease`。

## 为什么需要它

`@eldment/meting-agent` 不是浏览器 SDK，而是 Node 18+ 的 MCP 标准输入输出服务。静态网页无法直接启动它；Cookie 也绝不能写进 `index.html`。本桥接层在 Node 后端启动 MCP 子进程，并把每位用户的网易云 Cookie 加密成短期 bearer token。

## 部署（Render）

1. 把本目录上传到一个单独的 Git 仓库。
2. Render → New → Blueprint，选择仓库；或 New Web Service：Build `npm ci`，Start `npm start`。
3. 设置：
   - `METING_ALLOWED_ORIGINS=https://你的用户名.github.io,https://你的自定义域名`
   - `METING_SESSION_SECRET`：至少 32 字符的随机值；不要发给任何人。
4. 部署后访问 `https://你的服务域名/health`。

## 安全模型

- 原始 Cookie 只在 HTTPS 请求和 Node 内存中短暂出现；服务端不落盘、不打印。
- 返回 AES-256-GCM 加密会话，默认 12 小时；浏览器应只放 `sessionStorage`。
- CORS 必须是精确来源，不要设 `*`。
- 修改 `METING_SESSION_SECRET` 会立即使全部旧会话失效。
- 不要在聊天、代码、截图或仓库中粘贴真实 Cookie。

## API

- `GET /health`
- `POST /api/session` `{ "cookie": "..." }`
- `POST /api/search` `{ "keyword": "...", "page": 1, "limit": 20 }`
- `POST /api/song|album|artist|playlist|lyric` `{ "id": "..." }`
- `POST /api/url` `{ "id": "...", "br": 320 }`
- `POST /api/pic` `{ "id": "...", "size": 500 }`

除 `/health` 与 `/api/session` 外，发送 `Authorization: Bearer <token>`。

## 限制与风险

该项目基于第三方 Meting 兼容层和音乐平台的非官方接口，并非网易云官方开放平台。上游接口可能变化、限流或封禁；播放链接可能为空、短时有效、受会员/地区/版权/CORS 限制。请确认你的使用方式符合平台条款和当地法律，不要公开共享账号 Cookie 或绕过付费权益。
