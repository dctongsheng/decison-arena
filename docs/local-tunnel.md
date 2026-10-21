# 本地 Cloudflare Tunnel

当前公开地址为 **https://arena.startlux-decision.com/zh**（`decision`）。网站仍运行在本机，未部署 Workers。电脑和网络必须持续运行。

生产构建的启动方法见 [local-production.md](./local-production.md)。下文的 Vite 启动方式仍用于开发；两种服务不能同时占用 5091/5092/5094。

## 本机映射与运行

- 独立 Tunnel：`decision-arena-local`，ID `9836f8d4-f8af-40b0-94a5-0a7b4f333e4c`。
- `arena.startlux-decision.com` 的 proxied CNAME 指向该 Tunnel。
- `/api/arena/arcade-sessions/<id>/socket` → `http://127.0.0.1:5094`。
- 棋类 `/api/arena/matches/<id>/socket?seat=...` 继续走同源 5091，由 Vite 的 WebSocket proxy 转到同一个认证 Bridge（5094）；无需修改现有 Tunnel 路由。Cloudflare Worker 构建仍使用原有 Service Binding。
- 其余网页/API → `http://127.0.0.1:5091`；内部 runner 5092 不转发到公网。
- Tunnel 配置：`~/.cloudflared/decision-arena-local.yml`。
- 独立用户 LaunchAgent：`~/Library/LaunchAgents/dev.startlux.decision-arena-tunnel.plist`。登录 macOS 后启动，退出时自动重启；不修改原有 Tunnel 的配置。
- Tunnel 日志：`~/Library/Logs/decision-arena/tunnel.log`；就绪检查：`curl --noproxy '*' http://127.0.0.1:20591/ready`。

启动站点（已有进程时不要再开第二份）：

```sh
cd /Users/biws01/Documents/install_everything/decision-arena
pnpm dev
```

重启 / 停止 / 重新加载 Tunnel：

```sh
launchctl kickstart -k gui/$(id -u)/dev.startlux.decision-arena-tunnel
launchctl bootout gui/$(id -u)/dev.startlux.decision-arena-tunnel
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.startlux.decision-arena-tunnel.plist
```

停止 Tunnel 不会删除 DNS，网站会暂时不可用；这不影响独立的模型 API Tunnel。

## 本地环境

忽略的 `apps/web/.env.development` 已设置以下非秘密项，现有数据库和密钥保留：

```dotenv
ARENA_PUBLIC_ORIGIN=https://arena.startlux-decision.com
VITE_APP_URL=https://arena.startlux-decision.com
AUTH_URL=https://arena.startlux-decision.com
AUTH_TRUSTED_ORIGINS=http://127.0.0.1:5091,http://localhost:5091,https://arena.startlux-decision.com
```

更改后完整重启 `pnpm dev`。此项目实际加载顺序为：已有进程环境 → `.env.local` → `.env.development` → `.env`，早先的值优先。修改前的环境备份位于忽略的 `artifacts/tunnel-backup/.env.development.before-tunnel`；含秘密，不能提交或分享。恢复备份并重启即可回到纯本地 origin。

开发适配只允许明确配置的公网 Host。仅来自 loopback、精确 Host 和单值 `X-Forwarded-Proto: https` 的请求可归一化为 HTTPS，原同源检查保持不变。公网游戏使用同源 WSS，本地仍用 5094；Bridge 验证 Cookie 与实际 owner。Vite 拒绝读取 `.env`、数据库、私有 artifacts、`.wrangler`、`.git` 及服务器构建产物。

## BambooNode 登录登记

**2026-10-21 已验证：** 当前安装共用 `decision-arena-local` 客户端，本地和公网回调均通过完整参数（包括 state 和 S256 challenge）预检。Chrome 完成真实授权后返回公网 Arena，账户模型目录自动加载 StartLux、Jev 1.13 和 Jev 1.14。未发起收费模型调用。

公网精确回调为：

```text
https://arena.startlux-decision.com/api/auth/oauth2/callback/bamboonode
```

保留 `openid profile email quota model_gateway`、PKCE S256、模型授权及刷新 token 能力。client ID 与 secret 必须属于同一登记，不要把 secret 发在聊天、PR 或仓库中。其他部署者须申请自己的客户端，并登记自己的精确回调。

此前公网登录 400 的原因是该客户端只允许本地回调。BambooNode 在实际主数据库的 `oauth2_clients.redirect_uris` 中追加正确公网地址、保留旧回调后解决。仅修改 Tunnel、DNS 或 Arena 的 `AUTH_URL` 不能代替服务端登记。若再遇到类似问题，应对照实际请求的 client ID、回调和权限，并检查 `.dev` 服务是否连接了正确主库；不要关闭 PKCE 或使用通配符绕过校验。

## 验证与访问诊断

- 公网直连 HTTPS 首页返回 200，证书验证成功。
- 未登录私有 API 返回 401；已认证的同源请求通过 CSRF 校验，错误 Origin 返回 403。
- 私有 artifact 读取返回 403，环境文件不会被下载。
- 公网 WSS 升级返回 101；匿名升级 401、错误 Origin 403。一局私有贪吃蛇练习完成输入、暂停/恢复、主动结束和 V2 回放读取。输入确认 756ms、广播可见 1126ms（单次观测，不是 SLA）。
- 测试使用已有本地 fixture 会话，不调用模型、不发布社区；与真实 BambooNode 登录验收区分。首次脚本在控制心跳稳定前启动被拒绝；等待心跳稳定并正确处理恢复后的控制连接代次后通过，未修改游戏规则。
- `pnpm test` 503 项通过；`pnpm typecheck`、`pnpm build`、`pnpm build:cloudflare` 通过。
- 本次本机代理访问新域名在 TLS 握手期间关闭连接，但 `curl --noproxy '*' https://arena.startlux-decision.com/zh` 可正常访问。若浏览器报连接关闭，先检查其代理路线；不要关闭 TLS 验证或放宽站点鉴权。

官方操作参考：[Tunnel DNS 路由](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/)。
