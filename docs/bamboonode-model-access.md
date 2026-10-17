# BambooNode 账号与模型接入

本功能让用户通过 BambooNode 登录并授权模型访问。Arena 在服务端换取受限的应用凭证，用户不必复制 API Key。手动填写 Key 的现有模型配置仍可使用。

用户看到的登录和授权页面是 `https://bamboonode.dev`；OAuth Token、UserInfo、模型目录和推理接口位于 `https://api.bamboonode.dev`。`.cn` 域名不是这里的别名。

## 固定模型与接口

| Arena provider ID | 精确模型 ID | 唯一推理地址 | 思考参数 |
| --- | --- | --- | --- |
| `bamboonode-systemone` | `startlux-decision-27b-autothink` | `https://api.bamboonode.dev/v1/decisions` | 棋类支持 `always`、`auto`、`never` |
| `bamboonode-decisions` | `typesafe/jev-1.13` | `https://api.bamboonode.dev/jev/v1/decisions` | 不发送 SystemOne 思考参数 |
| `bamboonode-decisions` | `typesafe/jev-1.14` | `https://api.bamboonode.dev/jev/v1/decisions` | 不发送 SystemOne 思考参数 |

三款实时游戏 Snake、Tetris、Platformer 在创建及每次推理时强制 `thinkMode: never`；SystemOne 请求相应发送 `think_mode: "never"`、`return_thought: false`。棋类配置和普通 BYOK 协议不因此改变。

这些 provider 不允许改域名、路径、端口或附加查询参数，不经过自定义地址的 DNS 流程，也不跟随 HTTP 重定向。`sk-bag_` 应用凭证只能交给 BambooNode provider；不能作为 OpenRouter、StartLux 直连或自定义地址的 Key 使用。

两种协议均提交 `model`、游戏 `state` 和有限候选 `questions`。返回值按实际 `answers`、`usage` 解析，候选必须对应本次请求且概率合法；没有合法答案就停止该次推理，不随机落子，也不把模型输出当成可执行代码。

## 上游需要先部署的能力

BambooNode 运营方需要先部署支持应用模型授权的 New API 后端和对应授权页，并为 Arena 登记外部保密 OAuth client：

- 授权类型：`authorization_code`、`refresh_token`；使用 PKCE，client secret 只保存在 Arena 服务端。
- scopes：`openid profile email quota model_gateway`。旧的仅身份登录授权不能直接获得模型访问，用户必须重新确认授权。
- 将该 client ID 加入后端 `BAMBOO_APP_GATEWAY_CLIENT_IDS` 许可名单。本地和生产使用不同 client ID、不同 client secret。
- 授权页展示允许的模型；授权记录冻结模型范围。新增模型需要用户重新授权，不能默默扩大旧授权。
- 为相应用户组配置启用的模型渠道、匹配路径的插件和计费价格。`typesafe/jev-1.13` 需要单独配置价格；不要假定存在内置价格，也不要未经确认复制 1.14 的价格。

模型列表取上游目录、当前授权范围和 Arena 支持列表的交集。目录为空时，先检查上游授权、渠道、用户组、插件和价格配置。

上游受限应用凭证使用该用户原有的账户额度与计费规则。它不会赠送独立额度，也不会变成可调用任意模型或管理接口的普通平台 Key。上游在每次调用时检查用户、client、grant、模型、路由和凭证状态。应用授权按固定到期时间失效；刷新 OAuth Token 不延长应用授权本身。

Arena 使用以下上游管理接口，均为服务端请求：

| 接口 | 用途 |
| --- | --- |
| `GET https://api.bamboonode.dev/api/bamboo/apps/models` | 读取当前账号和授权可用的模型目录 |
| `POST https://api.bamboonode.dev/api/bamboo/apps/gateway-key` | 使用稳定的 `installation_id` 获取该安装的受限凭证 |
| `POST https://api.bamboonode.dev/api/bamboo/apps/gateway-key/revoke` | 撤销该安装的受限凭证 |

上游凭证响应的 `expires_at` 是 Unix 秒；Arena 转换为毫秒后写入自己的连接表。不要直接把秒值用于本地到期比较。

## OAuth 回调登记

回调需要逐字匹配，不包含语言前缀 `/zh`，末尾也不加 `/`。

| 环境 | 建议 client ID | 完整回调 |
| --- | --- | --- |
| Node 本地开发 | `decision-arena-local` | `http://127.0.0.1:5091/api/auth/oauth2/callback/bamboonode` |
| 本地 Cloudflare 预览 | `decision-arena-local` | `http://127.0.0.1:5093/api/auth/oauth2/callback/bamboonode` |
| 生产 | `decision-arena` | `https://arena.startlux-desicion.com/api/auth/oauth2/callback/bamboonode` |

本地 client 可以同时登记两个本地回调。生产必须单独登记；上表的生产域名是项目部署目标，不表示 DNS、OAuth client 或站点已经部署。[生产 client 登记模板](bamboonode-production-client-registration.json) 包含本功能需要的五个 scopes 和两种 grant types。此前已登记的仅身份 client 仍需在上游升级，不能仅修改 Arena 的配置。

## Arena 配置与密钥

本地先运行 `pnpm install`、`pnpm setup:local`，再编辑被忽略的 `apps/web/.env.development`。

```dotenv
AUTH_MODE=bamboonode
VITE_APP_URL=http://127.0.0.1:5091
AUTH_URL=http://127.0.0.1:5091
AUTH_TRUSTED_ORIGINS=http://127.0.0.1:5091
BAMBOONODE_ISSUER=https://api.bamboonode.dev
BAMBOONODE_AUTHORIZATION_URL=https://bamboonode.dev/oauth/authorize
BAMBOONODE_TOKEN_URL=https://api.bamboonode.dev/oauth/token
BAMBOONODE_USERINFO_URL=https://api.bamboonode.dev/oauth/userinfo
BAMBOONODE_ACCOUNT_URL=https://bamboonode.dev
BAMBOONODE_CLIENT_ID=decision-arena-local
BAMBOONODE_CLIENT_SECRET=<仅在本机安全配置中填写>
BAMBOONODE_SCOPES=openid profile email quota model_gateway
BAMBOONODE_TOKEN_AUTH_METHOD=post
```

`post` 表示 Token 交换使用 `client_secret_post`；应与上游 client 登记一致。配置项支持的另一种方式是 `basic`。

保留 setup 生成的 `AUTH_SECRET`、`CONFIG_ENCRYPTION_KEY`、`ARENA_ENCRYPTION_KEY` 和本地桥接用的 `ARENA_INTERNAL_SECRET`。这些值不能写进文档、日志、浏览器代码或 Git：

- `AUTH_SECRET` 用于会话及加密存储的 OAuth Token，已有 Token 不应在未迁移的情况下换用另一个密钥解密。
- `ARENA_ENCRYPTION_KEY` 用于账号绑定的凭证加密；web 与 runner 必须使用同一值。备份数据库时也需要安全保管该密钥。
- `CONFIG_ENCRYPTION_KEY` 用于管理配置加密。
- `ARENA_INTERNAL_SECRET` 仅用于本地 Node 到 runner 的内部桥接。生产使用 Service Binding，不能暴露本地 runner 或使用 `LOCAL_DEV=true`。

生产将 OAuth client secret 和上述适用的服务端密钥存入 Workers Secrets；不要使用 `VITE_` 前缀。将 `VITE_APP_URL`、`AUTH_URL` 和 `AUTH_TRUSTED_ORIGINS` 设置为完整生产 HTTPS origin，重新构建。runner 只需共享凭证加密密钥，不需要 OAuth client secret、access token 或 refresh token。

## 数据库迁移与启动

新增迁移为 `apps/web/drizzle/0001_outstanding_network.sql`，创建 `arena_bamboo_connections`。web 与 runner 必须绑定同一个当前环境的数据库。

连接表按 `owner_id` 保存账号、安装 ID、凭证 ID、状态、到期时间、模型列表及同步锁。模型凭证密文保存在原有 `arena_credentials`；OAuth Token 使用加密的账号记录，不写入连接状态响应。

Node 本地开发使用 setup 建立的本地 SQLite/D1 文件。已有本地环境升级时，可在保留 OAuth 配置的情况下执行：

```sh
pnpm --filter @decision-arena/web db:push
pnpm dev
```

`db:push` 仅用于开发数据库。完整 Cloudflare 本地预览执行：

```sh
pnpm dev:cloudflare
```

该命令会构建、应用本地迁移，并在 `http://127.0.0.1:5093/zh` 启动预览。它使用独立的 `.wrangler/cloudflare-dev/` 数据，不与 5091 开发环境共用账号或对局。它从 `.env.development` 读取必要的 OAuth 配置，并将应用 origin 改为 5093。

生产先备份数据库和加密密钥，审阅所有未应用迁移，配置真实 D1 ID，再执行生产迁移。例如从仓库根目录执行：

```sh
pnpm exec wrangler d1 migrations apply decision-arena-db --remote --config apps/runner/wrangler.jsonc
pnpm build:cloudflare
```

此处 `--remote` 会修改配置指定的云数据库，只应由部署人员在核对账户、数据库和备份后执行。不要对生产使用 `db:push`。先完成兼容的数据库迁移，再部署 runner 和 web；具体 Worker、私有 R2 与 Service Binding 配置见 [Cloudflare 部署说明](cloudflare.md)。保留新表的前向兼容迁移，不以删除凭证或连接表的方式回滚应用。

## 连接、断开与运行边界

登录后，模型页可同步账号的可用模型。浏览器只读取状态和可选模型，不会收到 OAuth Token 或应用凭证。相关 Arena API 为已登录用户的 `GET /api/arena/bamboonode`、同源 `POST /api/arena/bamboonode/sync` 和 `POST /api/arena/bamboonode/disconnect`。

同步在数据库中持有跨 Worker 的短期锁。刷新 Token 的结果若因中断而不确定，要求重新授权，不自动重放一次性 refresh token。托管模型和凭证不允许通过普通 BYOK 增删改接口编辑或复用。

runner 在创建对局、发送模型请求前以及接受结果后，检查同一用户和凭证的连接仍为 `connected`、未到期且模型仍在许可目录。普通 BYOK 不依赖这张连接表。上游撤销、余额不足或 401/403 等错误会停止自动调用，进入现有棋类错误或实时游戏暂停流程；不会自动重发可能收费的推理。

断开时先在本地标记 `disconnected`、禁用并清空托管凭证，再请求上游撤销。即使上游暂时无法访问，本地也不会继续发起调用或应用断开后到达的旧结果。已发送并被上游接受的请求可能仍会完成并计费；断开不能追溯取消它。若界面提示远端撤销未确认，应在 BambooNode 撤销授权或再次执行断开。

重新授权会获得新的授权范围。旧的仅身份授权、过期授权、撤销授权或无法解密的旧 Token 都不能静默升级为模型访问。模型的私有思考文本仍遵循原有私有回放规则，公开社区回放不包含密钥、Token 或私有思考。

## 验证命令与验收

```sh
# 协议、固定地址、凭证边界等单元测试，无真实模型调用
pnpm exec vitest run packages/providers/src/providers.test.ts
pnpm test
pnpm typecheck

# 真实 workerd + D1/R2/DO 集成，模型响应使用 fixture
pnpm test:runner

# 两种构建
pnpm build
pnpm build:cloudflare
```

`pnpm dev:cloudflare --local-auth` 可启动仅用于 fixture 测试的隔离预览，再运行 `pnpm test:cloudflare`。此选项不改写 `.env.development`。`pnpm test:cloudflare` 是本地完整应用的无模型调用 smoke；其中本地注册 fixture 需要 `AUTH_MODE=local` 的隔离预览。它不能替代 BambooNode 登录验收，也不应为运行测试而改动生产认证方式。

OAuth 验收需要已登记的真实 client：分别在 5091、5093 或已部署的生产 origin 完成登录、scope 确认、模型同步、断开和重新授权；再用两个独立账号确认模型与凭证隔离。在用户明确允许真实调用时，才进行一次有上限的模型对局，检查额度和错误状态。自动化 fixture 通过不等于上游生产渠道已可用，也不代表模型棋力或游戏表现。
