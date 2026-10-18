# 给 BambooNode 维护者：让 Decision Arena 登录后直接使用本人模型额度

> 历史交接记录：下文保留接入开发前的现状与方案。Arena 消费端现已实现，当前配置以 [模型接入文档](bamboonode-model-access.md) 为准；实际授权仍待服务器问题排查，验证结果见 [本地验收记录](bamboonode-local-validation.md)。下文的“待完成”和线上快照不代表当前实现状态。

## 目标

Decision Arena 已完成 BambooNode OAuth 登录。下一步希望用户登录后直接选择 BambooNode 的 StartLux / Jev 开局，调用计入该用户自己的 BambooNode 账户，无需手动创建或填写 API Key。Arena 的登录、对局和模型配置仍按用户隔离。

涉及仓库与目标部署（不代表已经部署当前 PR）：

- API：https://github.com/hhrhhrhhr/new-api → https://api.bamboonode.dev
- 账号前端：https://github.com/hhrhhrhhr/zhongzhuan → https://bamboonode.dev
- Arena 本地客户端：`decision-arena-local`
- 本地回调：`http://127.0.0.1:5091/api/auth/oauth2/callback/bamboonode`
- Cloudflare 本地预览回调：`http://127.0.0.1:5093/api/auth/oauth2/callback/bamboonode`
- 未来生产客户端：`decision-arena`，回调 `https://arena.startlux-decision.com/api/auth/oauth2/callback/bamboonode`；保持与本地客户端隔离。

不需要在聊天、代码仓库或这份文档中填写任何真实密钥。

## 当前交付与域名边界

`bamboonode.dev` 与 `bamboonode.cn` 是独立站点。本项目只接入
`https://bamboonode.dev` 和 `https://api.bamboonode.dev`，不将 `.cn`
当作跳转目标或备用 API，也不混用两个站点的账号、凭证与额度。

后端实现已提交 [new-api PR #7](https://github.com/hhrhhrhhr/new-api/pull/7)，
账号授权页已提交 [zhongzhuan PR #1](https://github.com/hhrhhrhhr/zhongzhuan/pull/1)。
支持 StartLux、`typesafe/jev-1.13` 和 `typesafe/jev-1.14`；具体启用范围仍受
用户授权、渠道与计费配置限制，1.13 的价格需要单独配置。
请按 PR 中的 `.dev` 部署说明先部署 API，再部署账号前端。

以下现状和建议记录于上述 PR 实现之前，最终接口契约以 PR 文档为准。
PR 提交不表示已部署；Arena 自动获取模型额度的消费端接入仍待完成。

## 已核实的现状（2026-10-16）

线上只读检查：

1. `GET /.well-known/openid-configuration` 返回支持 `openid profile email quota model_gateway`。
2. `GET /api/oauth/client-info?client_id=decision-arena-local` 返回该客户端实际只允许 `openid profile email`。
3. `GET /api/bamboo/models` 是公共展示目录，不能据此认定当前用户有模型调用权限；本次响应未找到 StartLux / Jev 条目。
4. Arena 已完成一次真实登录并建立 `provider_id=bamboonode` 的账户映射和会话；新账户没有保存模型。原本地账户的模型和凭证没有迁移。

仓库源码检查（需要维护者确认部署版本一致）：`new-api` 提交 `c2e23eaf385217b233cd8f265f999925fe352367`，`zhongzhuan` 提交 `24f6d2cffadfdbe400180bb8296b532d2f2e9b2c`。

- `controller/bamboo_desktop_gateway_key.go` 中 `bambooDesktopGatewayUser` 只允许 `bamboo-cowork` 客户端，并检查 `model_gateway` scope；其他客户端返回 HTTP 403 / `OAUTH_CLIENT_NOT_ALLOWED`。
- `/api/bamboo/desktop/gateway-key` 是 OAuth 换取个人网关 Key 的接口，不是通用外部应用接口。现有 Key 指纹仅包含 user/device，不能直接放开所有应用共享这个命名空间。
- `/v1/models` 和决策插件使用 `TokenAuth`，需要网关 API Key；登录用的 OAuth access token 不能直接当作推理 Key。
- StartLux 插件：`plugins/tasks/startlux/plugin.js`，入口 `/v1/decisions`，声明模型 `startlux-decision-27b-autothink`。
- Jev 插件：`plugins/tasks/jev/plugin.js`，入口 `/jev/v1/decisions`，声明模型 `typesafe/jev-1.14`。两个模型不能统一发到 StartLux 的路由；部署时请确认实际启用的模型 ID。
- `zhongzhuan/app/oauth/authorize/route.ts` 目前在验证账号后直接签发授权码；需要明确处理外部应用新增模型额度使用权限的授权体验。

源码定位：[网关客户端限制](https://github.com/hhrhhrhhr/new-api/blob/c2e23eaf385217b233cd8f265f999925fe352367/controller/bamboo_desktop_gateway_key.go#L34)、[StartLux 插件](https://github.com/hhrhhrhhr/new-api/blob/c2e23eaf385217b233cd8f265f999925fe352367/plugins/tasks/startlux/plugin.js)、[Jev 插件](https://github.com/hhrhhrhhr/new-api/blob/c2e23eaf385217b233cd8f265f999925fe352367/plugins/tasks/jev/plugin.js)、[账号前端授权路由](https://github.com/hhrhhrhhr/zhongzhuan/blob/24f6d2cffadfdbe400180bb8296b532d2f2e9b2c/app/oauth/authorize/route.ts)。

以上源码发现不等于线上已部署对应能力。本次没有尝试签发网关 Key，也没有发送付费推理请求。

## 请在服务端完成的工作

1. 扩展已注册的 `decision-arena-local`：允许 `openid profile email quota model_gateway`，并支持 `authorization_code` 与 `refresh_token`。保留现有 client secret、回调地址、PKCE S256 和外部客户端身份。生产客户端单独登记与配置。

2. 提供外部应用可用的网关授权接口。建议新增下面的接口；如果选择其他接口，请交付准确路径、认证方式和请求/响应契约后再对接 Arena。这是待实现的建议契约，不是声称已有的接口：

   - `POST /api/bamboo/apps/gateway-key`
   - `POST /api/bamboo/apps/gateway-key/revoke`
   - 使用 OAuth Bearer token 认证，必须同时验证已登记且启用的客户端、运营者配置的应用白名单、`model_gateway` scope 和当前用户状态。
   - 请求仅传稳定的 `installation_id`；user/client 必须取自已验证的 OAuth 身份，不能接受请求体指定其他用户。
   - 凭证与幂等标识绑定 `(client_id, user_id, installation_id)`。并发首次连接也只能创建一份有效凭证；应用之间不能读取或撤销对方凭证。
   - 返回 `Cache-Control: no-store`，成功响应建议为 `{ "success": true, "data": { "key": "<gateway key>", "token_id": 123, "name": "Decision Arena", "expires_at": 1234567890, "model_ids": ["<enabled model IDs>"] } }`。`expires_at` 明确采用 Unix 秒；如允许长期凭证则显式返回 `null`，不要由调用方猜测。
   - 仅允许 Arena 所需的决策模型与推理权限，仍使用本人当前可用的渠道、用户分组及真实余额。接口自身不执行推理、不预扣调用费。
   - 明确有效期、续期、用户禁用 Key、撤销应用授权、禁用客户端后的行为。用户主动撤销后，不得由后台同步悄悄重新签发；必须重新授权。
   - 保持原 Bamboo Desktop 接口与已签发凭证兼容，不让 Arena 伪装为 `bamboo-cowork`。

3. 提供准确的账户可用模型信息：可以复用持有专属网关 Key 后的 `GET /v1/models`，但需确认包含已启用的 StartLux/Jev 决策插件模型。若该接口不包含插件模型，提供受同等认证约束的决策模型列表。每项给出模型 ID、展示名、决策请求路径、支持的思考参数；公共营销目录不能代替账户权限校验。

4. 核实决策路由和额度扣费：StartLux `/v1/decisions`，Jev `/jev/v1/decisions`。请求仍使用 `state + questions` 协议，结果保留实际模型、概率与用量。应用凭证权限、模型权限、额度不足均须在执行前校验；不能绕过现有计费链路。

5. `quota` 通过 `/oauth/userinfo` 或专用账户接口返回本人余额；交付字段单位和换算方式。余额未知时 Arena 显示“未返回”，不会自行把 quota 数字解释成金额。

6. 完成应用授权体验：首次请求 `model_gateway` 时明确显示“允许 Decision Arena 调用指定模型并使用你的 BambooNode 额度”，提供同意/拒绝和撤销入口。保留 OAuth state、精确回调校验、PKCE、CSRF 保护；不得通过带敏感信息的 URL 传递 Key。

## 服务端验收与交付

- 两个用户、两个应用分别验证凭证隔离、幂等创建和撤销；无权限客户端、缺少 scope、禁用用户均拒绝。
- 修改客户端数据库配置后，从线上 client-info 能读到新增 scope；旧授权 token 不会自动获得新增权限，需要重新授权。
- StartLux/Jev 分别验证一条有限的真实请求，核对调用归属、实际模型和余额变更。不要用管理员共享 Key 代替用户凭证。
- 验证不足额、过期、用户撤销、客户端停用和网关不可用；失败不能转用其他用户或平台凭证。
- 部署到实际 `api.bamboonode.dev` / `bamboonode.dev`，不要只提交仓库。
- 回复部署版本、最终接口契约、允许的 scopes、有效模型 ID/路由、额度单位及去敏验证结果。已有 client secret 无需再发送。

## Arena 侧待接入（由本项目完成）

服务端契约确认并部署后，Arena 将请求新增权限，完成专属网关凭证的服务端加密保存与必要续期，按当前账户同步模型，自动出现在模型页和两类开局选择器。模型配置使用稳定 ID，标记“使用本人 BambooNode 额度”，保留原有自带 Key 模式。

实际开局与调用再次检查授权及模型权限；公共回放不包含凭证、私有接口或授权信息。克隆对局使用观看者自己的授权。三款实时游戏继续强制关闭思考。同步和列举模型不发送收费测试请求。

这份文件是服务端接入交接说明；不表示免填 Key 功能已经实现或已通过真实调用验收。
