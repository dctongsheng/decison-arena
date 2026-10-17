# BambooNode 接入：本地验收记录

日期：2026-10-17。范围：Arena 源码、本地 5091 站点和独立 Cloudflare 5093 预览；未部署生产，未修改 BambooNode 服务器。

## 已完成

- 登录授权请求包含 `openid profile email quota model_gateway`，PKCE S256 和精确本地回调。
- 账号连接服务自动生成 StartLux、Jev 1.13、Jev 1.14 配置，模型目录以账号实际授权/可用渠道为准。
- OAuth Token 与应用模型 Key 分别加密保存；固定 `.dev` API 出站；托管 Key 不可在自定义地址复用。
- 刷新与同步跨进程加锁，授权代次与数据库快照 CAS；未知刷新结果要求重新授权；断开、缩权及 Key 更换后的迟到决策不能落子。
- 棋类、三个实时游戏、记录、公开回放与社区兼容；实时游戏保持禁止思考。
- 本地开发 OAuth 配置已升级并保留原有密钥；新迁移已应用，5091/5092 开发服务已启动。

## 自动化验收

- `pnpm test`：392 项通过。
- `pnpm test:runner`：96 项通过，真实本地 workerd、D1、R2、Durable Objects；模型返回使用 fixture。
- `pnpm typecheck`：通过。
- `pnpm build` 与 `pnpm build:cloudflare`：通过。
- `pnpm test:cloudflare`：在 `pnpm dev:cloudflare --skip-build --local-auth` 的隔离环境通过，覆盖登录、加密凭证、Service Binding、棋类和三个实时游戏、WebSocket、暂停恢复、记录、双版本回放、社区互动、撤回及租户隔离。
- 首次 Cloudflare 实时测量：输入确认约 1ms；广播约 99–101ms（本机短样本，不代表公网延迟）。

`--local-auth` 仅将独立 5093 预览设为 fixture 邮箱登录，未改变 5091 的 BambooNode 登录，也没有改生产设置。

## 真实授权：尚未通过，不能宣称可直接扣额度开局

5091 浏览器正确识别旧账号仅有身份权限，并显示“授权 BambooNode”。用户执行授权时收到：

```json
{"error":"invalid_request","error_description":"Authorization could not be completed. Return to the application and start again."}
```

核查 Arena 真实生成的请求：

- 授权地址：`https://bamboonode.dev/oauth/authorize`
- `client_id=decision-arena-local`
- 回调：`http://127.0.0.1:5091/api/auth/oauth2/callback/bamboonode`
- scopes：五项完整权限
- `response_type=code`；`code_challenge_method=S256`；challenge 长度 43；state 长度 32
- 相同参数请求 `https://api.bamboonode.dev/api/oauth/client-info`：HTTP 200，`model_gateway_enabled=true`、`requires_model_gateway_consent=true`，三款模型均在客户端授权列表。

这证明请求形状及后端客户端登记有效，不证明前端服务器的内部授权接口正常。用户进一步确认：授权页可以显示，点击同意之后才出现错误，因此排查范围缩小到 `POST /oauth/authorize`，尚未到 Arena 回调。

已通过真实浏览器核对线上表单：原生 POST、`application/x-www-form-urlencoded`，字段为 `consent` 与 `decision`，页面 `referrer` 为 `same-origin`。两端源码的 `model_gateway_consent` / `model_gateway_models` 字段匹配；前端授权流程的 19 项单元测试通过。这些证据仍不能确定部署环境中的失败阶段。

POST 状态的区分：403 表示前端同源检查失败；401 表示 session 缺失；400 可能是表单、过期/已消费的同意凭证、客户端配置快照变化，也可能是内部授权接口错误被通用 catch 隐藏。公开 `client-info` 成功不证明前端 `NEWAPI_INTERNAL_KEY` 与后端 `INTERNAL_API_KEY` 匹配，后者只在内部授权调用时检查。

无 Cookie 的脚本对前端授权页探测被 Cloudflare 1010 拒绝，不能用它代替已登录浏览器测试。

用户再次提交后，已在其实际 Chrome 错误页面读取到 Navigation Timing 的 `responseStatus=400`，页面正文为上述 `invalid_request`。这排除了源码中固定返回 403 的同源拒绝分支。随后从 Arena 新建授权流程并直接点击同意，捕获的原生 POST 使用 `Origin: https://bamboonode.dev`、`Sec-Fetch-Site: same-origin`、`Content-Type: application/x-www-form-urlencoded`，提交字段名称恰为 `consent` 和 `decision`。未导出字段值、Cookie、完整授权 URL 或 Key。新请求尚未得到可确认的响应，不能宣称回调成功；不要重复提交同一份同意凭证。

对前端授权和社交登录的 34 项单元测试通过；会话刷新保留 sid，目标源码与已合并分支一致。下一步需要前端服务端失败阶段和内部授权接口状态，不能仅从通用 400 推断内部密钥一定有错。

### 安全诊断补丁

已提交前端 [zhongzhuan PR #2](https://github.com/hhrhhrhhr/zhongzhuan/pull/2)，提交 `4ace928`。失败响应增加服务端生成的 `request_id`；服务端日志只记录该编号、方法、阶段、固定原因、状态和可选的上游数字状态。授权校验及一次性同意语义不变，不记录敏感字段。新增诊断回归后共 62 项相关测试、类型检查、生产构建均通过。

该 PR 尚未合并/部署，也不是已确认的根因修复。部署人员可合并部署后从 Arena 新建一次授权，通过错误页编号查询对应前端日志，以进一步确定实际失败阶段。目前无法访问朋友的部署服务器日志；Chrome 自动控制也出现响应读取超时，因此自己的新提交没有得到可确认的最终响应，不能以此判断后端超时或授权成功。

本轮尚未取得完整模型授权，因此未发起真实模型付费请求；模型自动加载、实际额度扣费及真实对局仍待授权恢复后验收。没有用旧的手填 Key 代替本人 BambooNode 授权来制造成功结果。

## 可转发给部署人员的排查任务

> Decision Arena 已完成五 scope + PKCE 接入。用 `decision-arena-local` 和 5091 回调请求公开 `/api/oauth/client-info` 已返回 HTTP 200，模型授权开启且包含 StartLux、Jev 1.13、Jev 1.14。用户可正常看到授权页，但点击同意后的 `POST https://bamboonode.dev/oauth/authorize` 返回通用 `invalid_request`，尚未到 Arena 回调。
>
> 请先查同一时间前端 POST 的状态和后端是否收到 `/internal/auth/authorize`。前端 403 时核对 `APP_ORIGIN=https://bamboonode.dev` 与浏览器 Origin、代理是否保留该头。前端 400 时区分 `consume_consent`、`verify_client` 和 `internal_authorize`；后端内部接口 401 时核对前端 `NEWAPI_INTERNAL_KEY` 与后端 `INTERNAL_API_KEY` 是否一致；后端 500 时检查授权记录/授权码写入及数据库迁移（`oauth_app_grants.models_json` 和授权码的 `gateway_grant_id`）。所有前端实例须共享 Redis 和一致的 `SESSION_SECRET`。仅返回失败分类和状态，不发送任何 Key。
>
> 请给 GET/POST `/oauth/authorize` 的失败路径增加仅含阶段与错误类别的服务端诊断，例如 `parse_request`、`verify_client`、`read_session`、`create_consent`、`consume_consent`、`internal_authorize`，并返回/记录关联 ID。不要记录完整请求 URL、Cookie、state、code、access/refresh token 或 Key。请告知这次失败的阶段、HTTP 状态及部署版本，修复后让用户从 Arena 重新发起授权，不复用旧授权链接。`.dev` 与 `.cn` 是独立环境，请勿互相回退。

生产仍使用独立 client `decision-arena`，回调 `https://arena.startlux-desicion.com/api/auth/oauth2/callback/bamboonode`，详见接入文档。
