# 本地 Cloudflare Tunnel

当前公开地址为 **https://arena.startlux-decision.com/zh**（`decision`）。网站仍运行在本机，未部署 Workers。电脑、网络和 `pnpm dev` 必须持续运行。

## 本机映射与运行

- 独立 Tunnel：`decision-arena-local`，ID `9836f8d4-f8af-40b0-94a5-0a7b4f333e4c`。
- `arena.startlux-decision.com` 的 proxied CNAME 指向该 Tunnel。
- `/api/arena/arcade-sessions/<id>/socket` → `http://127.0.0.1:5094`。
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

## BambooNode 登录尚需修正登记

2026-10-17 的匿名 `client-info` 对照检查结果：

| Client | 回调地址 | 五 scopes | 结果 |
| --- | --- | --- | --- |
| `decision-arena-local` | `http://127.0.0.1:5091/api/auth/oauth2/callback/bamboonode` | 完整 | 200 / 允许 |
| `decision-arena-local` | 正确公网域名 | 完整 | 400 / 拒绝 |
| `decision-arena` | 原拼错的公网域名 | 完整 | 200 / 允许 |
| `decision-arena` | 正确公网域名 | 完整 | 400 / 拒绝 |

正确公网域名即使只请求身份 scopes 仍被拒绝。Tunnel 和 DNS 无法代替 OAuth 客户端登记。

请 BambooNode 维护者更新 `decision-arena` 的精确回调为：

```text
https://arena.startlux-decision.com/api/auth/oauth2/callback/bamboonode
```

保留 `openid profile email quota model_gateway`、PKCE S256、模型授权及刷新 token 能力。然后将生产 client 对应的 secret 安全写入本地忽略文件（不要发在聊天、PR 或仓库中），与 `BAMBOONODE_CLIENT_ID=decision-arena` 配套，再重启并完成浏览器授权测试。当前 `.env.development` 仍保留原 `decision-arena-local` 凭证，不能仅把 client_id 改成生产 ID 而沿用另一客户端的 secret。此次未声称公网 OAuth 回调已成功。

## 验证与访问诊断

- 公网直连 HTTPS 首页返回 200，证书验证成功。
- 未登录私有 API 返回 401；已认证的同源请求通过 CSRF 校验，错误 Origin 返回 403。
- 私有 artifact 读取返回 403，环境文件不会被下载。
- 公网 WSS 升级返回 101；匿名升级 401、错误 Origin 403。一局私有贪吃蛇练习完成输入、暂停/恢复、主动结束和 V2 回放读取。输入确认 756ms、广播可见 1126ms（单次观测，不是 SLA）。
- 测试使用已有本地 fixture 会话，不调用模型、不发布社区；与真实 BambooNode 登录验收区分。首次脚本在控制心跳稳定前启动被拒绝；等待心跳稳定并正确处理恢复后的控制连接代次后通过，未修改游戏规则。
- `pnpm test` 503 项通过；`pnpm typecheck`、`pnpm build`、`pnpm build:cloudflare` 通过。
- 本次本机代理访问新域名在 TLS 握手期间关闭连接，但 `curl --noproxy '*' https://arena.startlux-decision.com/zh` 可正常访问。若浏览器报连接关闭，先检查其代理路线；不要关闭 TLS 验证或放宽站点鉴权。

官方操作参考：[Tunnel DNS 路由](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/)。
