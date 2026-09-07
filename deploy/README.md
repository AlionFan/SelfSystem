# Me 账号版部署与恢复

域名 `me.joybeat.cn`。北京腾讯云服务器于 2027-06-16 00:18:22（Asia/Shanghai）到期。备案：京ICP备2026054579号。

应用由 Coolify 服务 `c6zlqam9byswlqx825cse0bc` 管理；应用容器不发布宿主机端口，只连接现有 `coolify` 网络。数据 `/data/joybeat-me/data`，运行配置 `/data/joybeat-me/config` 只读挂载。仅修改 `/data/coolify/proxy/dynamic/me.yaml` 的域名路由，不改变其他服务或默认 TLS 策略。

## 配置

`AUTH_MODE=account`，`ACCOUNT_CONFIG_FILE=/config/account.json`，字段见 `account.example.json`。

- `secret`：32 字节安全随机数的 base64url 表示。用于会话防伪、验证码摘要和 PushPlus 令牌加密。迁移必须保留，不能每次部署重新生成。
- `ownerEmail`：`1210604006@cnu.edu.cn`。首次迁移保留该主账号，原记录、历史操作和设备归其所有。主账号完成邮箱验证注册后设置自己的密码。
- `registration`：`open`，注册必须通过邮箱验证码，不设未验证后门。
- `smtp`：发信地址及 SMTP 专用授权码。QQ SMTP 465 已完成服务器 TLS 认证和实际发信受理验证；Gmail SMTP 465 和 587 从北京超时。实际配置使用 QQ 专用授权码。
- `smtp.dailyLimit`：全站每日验证码发信上限，默认 100；每邮箱每分钟 1 次、每天 10 次，每来源每小时 10 次。按实际邮箱额度调整全站限额。
- `wechatProvider`：`pushplus`。每用户独立绑定，令牌只保存在服务端密文中。

真实配置不得提交源码、聊天或日志，服务器归属 UID 1000，文件权限 600，目录 700。备份包含配置密钥，必须私有保存。登录密码只存 scrypt 摘要，会话仅在 Secure/HttpOnly Cookie 中；邮件验证码十分钟有效、最多五次尝试。

## 从证书版切换（已完成，供重建与恢复参考）

当前正式版本是 `joybeat-me:2.0.1`。账号版于 2026-09-06 完成切换，2.0.1 为同日首页更新。部署过程遵循：

1. `npm test`、`npm run build` 通过。在服务器无外网隔离容器上测试新版，使用一致性数据库副本核对内容、归属和备份格式。
2. 配置真实 SMTP 专用授权码，在北京服务器验证 TLS 认证与投递；不得以跳过邮箱验证代替配置。
3. 保存原镜像、Coolify Compose、独立代理文件和数据库一致性备份。旧数据库含 WAL，不能只复制运行中的主文件。
4. 将账号配置放入 `/config/account.json`，通过 Coolify 更新本服务 Compose 并重启。先保留原客户端证书代理，确认新容器健康、`/api/entries` 未登录返回 401、旧记录均归主账号。
5. 仅移除 Me 路由的 `me-client-auth@file` 要求与 `me-cert`、`me-proof` 中间件。保留 HTTPS、自动证书签发、HTTP 转 HTTPS 和无额外公网端口设置。
6. 不带客户端证书检查登录页与注册页；未登录内容接口仍应 401。验证主账号注册后原有记录可见、其他账号为空，API 与导出隔离。验证后重新备份并拉回 Mac。
7. 撤销部署临时令牌，恢复 Coolify API 原开关状态，停止隔离验收容器并清理临时上传文件。

Coolify 更新使用 `PATCH /api/v1/services/{uuid}`，`docker_compose_raw` 为 base64 编码，显式 `instant_deploy:false`；随后调用服务重启。只更新当前服务，保留其他字段。[官方接口](https://next.coolify.io/docs/api/endpoints/services/update-service-by-uuid)

证书签发私钥和旧设备安装包继续保留在本机 `.local/access` 作为历史恢复资料；无需上传到服务器。完成账号切换后用户无需安装客户端证书。

## 2.0.1 首页更新与回退

本次只更换本服务镜像，保持原 Compose 的其余字段、账号配置和代理设置。回退至 2.0.0 时，只需通过 Coolify 将镜像切回并重启 Me，保留当前数据库，避免丢失期间的新记录。原 Compose 和一致性备份在 `/data/joybeat-me/rollback/pre-board-20260906T061703Z`。

## 备份与迁移

`node scripts/backup.mjs` 使用 SQLite 一致性备份并生成服务端 JSON：

- SQLite 保留账号、密码摘要、会话、数据归属、设备、提醒和去重状态，用于完整恢复。
- 服务端 JSON 格式 `joybeat-me-server`、`schemaVersion:2`，按 `accounts[]` 分开各用户数据，不可直接导入某个普通账号。
- 网页导出仍为 `joybeat-me` 格式，仅当前用户记录；只能用于恢复内容，不能恢复身份信息或通知配置。

服务器每日 03:20 起五分钟内备份，保留 30 天；Mac 每六小时取回最新备份，保留 60 天。Mac 离线时不会产生新的异地副本。配置和账号密钥必须与数据库共同备份。

迁移时先停旧站调度，恢复数据库与同一份账号配置，设置新机 HTTPS，再切 DNS，避免两台同时发送提醒。验证登录、邮箱验证码、账号隔离和提醒回执；在实例到期前至少一个月完成演练。

回退需要恢复升级前数据库、旧镜像、Compose 和 Me 代理文件。新用户注册或写入后不可直接覆盖为旧数据库；先另存新版数据并评估增量迁移，避免丢失升级后的记录。

## 2.1 AI 配置和回退注意

`AI_CONFIG_FILE=/config/ai.json` 指向只读配置目录中的独立文件，例见 `ai.example.json`。该文件缺失时保留记录功能并显示 AI 待配置；不能将真实密钥放入 Compose、源码或网页。部署后复制受保护的配置并重启 Me 才加载新值。

当前数据含 `captureMode`、`capturedAt`、`originalBody`、`aiSummary`、`quadrant`、`phase` 和分离的日期/时间字段。AI 队列、偏好、用量、个人回执在 SQLite，完整服务器备份会包含它们和 config 目录；普通用户 JSON 仅导出自己的记录和原文。恢复应整体保留 SQLite 与匹配的 account.json，ai.json 单独配置也可安全降级。

2.0.1 及更早验证器不接受新字段。已有新版本写入后，不能照搬旧版“仅换镜像”回退方式；优先修复新镜像，或保留所有新增数据并进行兼容转换后再退。升级前备份不是覆盖当前数据的许可。
