# 青龙面板

运行在 Cloudflare Workers 免费档上的个人定时任务面板。原生 HTML/CSS/JavaScript，无前端构建、无运行时依赖、无 KV。

Static Assets 提供页面；一个 SQLite Durable Object 串行调度与修改任务；D1 保存任务、凭据、日志、通知设置和待执行作业。保留 D1 是为了兼容现有数据，代价是每次状态读取都访问 D1。

## 功能

- GLaDOS 多账号签到、积分查询、满 500 积分兑换；Cookie 支持每行一个账号或 Cookie-Editor JSON 数组。
- DNSHE 域名分页检查与续期；永久域名和距到期超过 180 天的域名直接跳过。
- 分钟间隔、按天、按月计划；UTC+8 默认时区。间隔从保存时刻起计，按月日期限制 1–28 日。
- 手动运行快速入队、重复请求合并；每次闹钟执行一个作业，各任务独立补跑剩余项。
- 每任务保留最近 200 行日志；结果先事务保存，再发送 TimelyNotify 通知。
- 手机/桌面布局、深浅主题、原生时间选择与弹窗、真正清除登录 Cookie。

每轮最多 40 次业务请求，预留通知与平台调用空间；超过预算的剩余项在 60 秒后继续，DNSHE 补跑不重新拉取全量列表。无任务到期时不额外安排小时闹钟；小时 Cron 只检查和修复闹钟。外部接口执行中断后的结果可能未知，记录失败供人工核对，不自动重发有副作用的请求；外部服务不支持幂等时无法保证严格恰好一次。

GLaDOS 签到请求完整镜像浏览器客户端：先取签到挑战（nonce），提交 SHA-256 证明与浏览器请求指纹；人机验证未放行时自动回退标准签到。日志保留签到消息、积分构成、连续天数与积分历史，奖励仍由服务端决定，不承诺提高奖励。积分历史第一项可能是兑换等其他操作，不能仅凭该项认定当天签到奖励。

## 部署

需要 Node.js 24。GitHub Secrets 配置 `CLOUDFLARE_API_TOKEN`（Workers 和 D1 编辑权限）、`CLOUDFLARE_ACCOUNT_ID`，可选 `PANEL_PASSWORD`。推送 main 后，CI 执行检查、查找或创建名为 qinglong 的 D1 库、部署并同步可选密码。已有库、DO 类名和 `default` 实例身份保持兼容，表结构自动补齐；不删除原有任务或凭据。符合旧版补跑结构的行会暂停并留日志，防止升级后变成每分钟重复执行；请人工核对剩余项。名称恰好相同且结构也相同的自建任务也可能被暂停，可核对后恢复。

手动部署：`npm ci`，在 wrangler.toml 填入 D1 database_id，执行 `npx wrangler secret put PANEL_PASSWORD`、`npm run deploy`。首次部署后访问 `/health` 安排闹钟；此接口不返回任务凭据。

凭据只填在面板中，保存在 D1；不要写入代码。使用足够长的面板密码。静态资源公开，所有业务 API 都要求登录。登录有效期 30 天，修改密码使旧 Cookie 失效；退出清除当前浏览器 Cookie。

## 本地开发与验证

```sh
npm ci
npm test
npm run check
npx wrangler deploy --dry-run
npm run simulate
```

模拟面板地址 http://127.0.0.1:8791，密码 `local-test-password`，全部业务接口返回假数据，不会真实签到、续期或推送。模拟器使用 Node 原生 SQLite，执行实际应用 SQL 和调度代码，不能模拟 Cloudflare CPU 配额、网络行为或所有故障重试。

`npm run dev` 启动官方 workerd 本地运行时；先将 `.dev.vars.example` 复制为 `.dev.vars` 并修改密码。官方开发模式会使用真实外部接口，除非另行配置隔离。调试产物和依赖目录都已忽略。

Windows 无 Git 环境可用 `pwsh -File tools/upload.ps1 owner/repo "修改原因"` 预览上传清单，追加 `-Publish` 才发布。发布会让 main 的文件树与清单一致，删除清单外远端文件并触发部署；不上传 `.dev.vars`、依赖和缓存。

## 免费额度与取舍

按 Cloudflare 官方文档，Workers 免费档每日 10 万请求、每次 Worker 调用 10ms CPU；静态资源直接命中不消耗 Worker 请求。Durable Object 有独立执行限制与每日请求、存活时间额度，存活时间按墙钟计费，不等于 CPU。D1 免费档每日读取 500 万行、写入 10 万行，总存储 5GB。KV 本项目使用量为零。

面板可见且空闲时每 120 秒刷新，有作业时每 3 秒刷新，隐藏时停止；以少量状态延迟换取更低请求数。实际 CPU 和行读取量应以 Cloudflare 指标为准，本地耗时不能当作生产计费数据。

- [Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)
- [Durable Objects 计费](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [D1 计费](https://developers.cloudflare.com/d1/platform/pricing/)
- [Static Assets 计费](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)
