# 本机生产构建 + Cloudflare Tunnel

这条运行方式在 Mac 上运行编译后的 Node 网站，并用本机 workerd 执行原有 Durable Objects。公网入口仍是 `https://arena.startlux-decision.com`；电脑必须开机、联网且不能休眠。这不是部署到 Cloudflare Workers。

## 构建与启动

```sh
pnpm build:local-production
pnpm start:local-production
```

启动前先停止占用 5091、5092、5094 的开发服务。脚本仅监听 loopback，不运行数据库迁移，不生成新密钥，也不重新初始化账户。

- 网站：`127.0.0.1:5091`，Nitro `node_middleware` 生产构建，包含静态资源。
- runner：`127.0.0.1:5092`，Wrangler 本地 runtime 加载编译后的 `index.js`，复用 `.wrangler/state` 的 D1、DO、R2。
- WebSocket 桥接：`127.0.0.1:5094`，与网站同源 upgrade 共用会话鉴权。保留 Tunnel 原有的 arcade socket 路由。
- `ARENA_LOCAL_PRODUCTION=true` 仅由启动器注入。默认 Node 生产和 Cloudflare Worker 仍拒绝无 Service Binding 的 HTTP runner fallback。

生产构建位于忽略提交的 `artifacts/local-production/releases/<时间>-<提交>/`。`current` 文件记录默认版本；后续普通构建或 Cloudflare 构建不会覆盖运行中的 release。网站 wrapper、运行依赖和启动脚本仍来自当前 checkout，修改它们后需要重新验证并重启。

## 环境和数据

默认读取现有 `apps/web/.env.development`，然后由可选的 `apps/web/.env.production` 覆盖生产专用配置。可以用 `ARENA_LOCAL_ENV_FILE=/绝对路径` 指定完整配置，此时不追加默认覆盖文件。配置不打印到日志。

网站与 `apps/runner/.dev.vars` 的 `ARENA_ENCRYPTION_KEY`、`ARENA_INTERNAL_SECRET` 必须一致；数据库必须是已经存在的绝对 SQLite 文件路径。切勿生成新加密密钥覆盖已有密钥，否则旧凭证无法解密。

生产 OAuth 必须使用已登记以下精确回调的客户端：

```
https://arena.startlux-decision.com/api/auth/oauth2/callback/bamboonode
```

将同一个客户端配套的 `BAMBOONODE_CLIENT_ID` 和 `BAMBOONODE_CLIENT_SECRET` 写入忽略提交、权限为 600 的 `.env.production`，并将 `AUTH_URL`、`VITE_APP_URL` 和 `ARENA_PUBLIC_ORIGIN` 设置为 `https://arena.startlux-decision.com`。不要把 secret 发到聊天或提交 Git，也不要只更换 client ID 而沿用另一个客户端的 secret。修改运行时 `AUTH_URL` 后重启；修改编译时 `VITE_APP_URL` 后重新构建。

当前安装按站点所有者的选择共用 `decision-arena-local` 客户端，BambooNode 已同时登记本地和公网回调。客户端名称中的 `local` 不决定回调地址，最终以服务端登记和 Arena 实际发送的 `redirect_uri` 为准。其他部署者须申请自己的客户端。OAuth 预检通过只证明注册参数被接受，完整登录还需要真实回调、token exchange 和站内会话验证。

启动前可在服务停止时备份整个 `.wrangler/state`。备份包含私有数据，应保留在忽略提交且访问受限的目录。不要在运行时直接复制 SQLite 文件当作一致性备份。

## 本机持久服务

本次安装的 LaunchAgent 标签为 `dev.startlux.decision-arena-production`，登录 macOS 后自动启动，并在意外退出时重启。既有 Tunnel LaunchAgent 独立运行。

```sh
# 重启网站、runner 和 socket bridge
launchctl kill SIGTERM gui/$(id -u)/dev.startlux.decision-arena-production

# 停止，释放端口以便切换回 pnpm dev
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/dev.startlux.decision-arena-production.plist

# 再启用
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.startlux.decision-arena-production.plist
```

日志：`~/Library/Logs/decision-arena/production.log`。Tunnel 日志在同一目录的 `tunnel.log`。runner 的受限本地日志在 `artifacts/local-production/logs/wrangler`。

回滚构建时，停止服务，将 `artifacts/local-production/current` 改为已存在的旧 release 目录名，再启动。若启动代码也发生变更，需要同时恢复兼容的代码版本。不要回滚或覆盖数据库；历史对局仍由各自冻结的规则/Harness 版本解释。

## 验证边界

验证 HTTPS 页面和静态资源、匿名私有 API 拒绝、错误 Host/Origin 拒绝、认证 WebSocket 及已有私有数据读取。启动验证不自动调用收费模型、不自动发布社区回放。不把未完成的 OAuth 回调或模型请求记为成功。

### 2026-10-19 本机启动记录

- `pnpm test`：726 项；`pnpm test:runner`：159 项；类型检查通过。普通、Cloudflare dry-run、Node middleware 生产构建通过，没有部署远程 Worker。
- 本地与公网 `/zh` 和生产 JS/CSS 返回 200；页面不含 Vite client。真实无头 Chromium 可加载公网页面，390/768/1440 宽度首页无水平溢出、无 pageerror。
- 私有模型 API 匿名 401；两类 WebSocket 本地 5091/5094 和公网均为匿名 401、非法 Origin 403；未知 Host 和伪造来源标记 403。
- `.env`、`.git/config`、私有 artifacts、`/@vite/client` 公网 404；编译产物 355 个文本文件未包含当前环境中的真实 secret/key；项目安全扫描无发现。
- 使用真实本机 runner 只读抽查已结束的五子棋与俄罗斯方块：所属账户 200，其他 owner 404。没有创建对局或调用模型。认证 WebSocket 的正向路径由自动化测试覆盖，此次未完成真实公网登录后的浏览器握手。
- 保留原数据库（启动前 16 账户、232 对局）并在 `artifacts/local-production/backups/state-before-production-20261019` 保存停机备份。
- 公网 OAuth 客户端注册预检通过，但本机尚缺 `decision-arena` 对应凭证；完整公网回调、模型授权和登录后开局不计为本次已验证。
- Python urllib 默认 UA 被 Cloudflare 返回 1010；标准浏览器和带浏览器 UA 的探测返回 200。未关闭 Cloudflare 防护或放宽来源校验。

### 2026-10-21 公网登录复验

- `decision-arena-local` 的本地、公网精确回调均通过完整七参数 `client-info` 校验，包含 `openid profile email quota model_gateway` 和 PKCE S256。
- Chrome 完成 BambooNode 授权后返回公网 Arena，显示已登录账户；模型页自动加载 StartLux、Jev 1.13 和 Jev 1.14，无需填写 API Key。
- 本次只验证登录和模型目录加载，没有发起收费模型调用，不代表模型对局已完成验证。
