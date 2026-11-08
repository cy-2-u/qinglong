# QingLong Panel · 青龙面板

[![Deploy](https://github.com/cy-2-u/qinglong/actions/workflows/deploy.yml/badge.svg)](https://github.com/cy-2-u/qinglong/actions/workflows/deploy.yml)

Cloudflare Workers 免费档上的个人定时任务面板：D1 存储 + Durable Object 闹钟调度 + 内置任务库 + TimelyNotify 推送。
脚本以 ES 模块随构建打包（Workers 禁止运行时编译字符串），面板只负责编排：选脚本、定节奏、看日志、收推送。

```
cron (每小时) ──► /health ──► DO.ensureAlarm()   兜底重算闹钟
                                       │
TaskScheduler DO ◄── alarm ────────────┘   闹钟 = min(最近任务锚点+5s, now+1h)
        │ Promise 队列单飞（心跳/手动互斥）
        ▼
   heartbeat ──► runner ──► 内置脚本 run(ctx) ──► 日志落 D1（环形 200 行）
        │                         └─ ctx.notify ──► TimelyNotify
        ▼
   D1 (tasks / logs / settings)
```

## 部署

GitHub Secrets 配 `CLOUDFLARE_API_TOKEN`（"Edit Cloudflare Workers" 模板 + D1 编辑权限）、`CLOUDFLARE_ACCOUNT_ID`，可选 `PANEL_PASSWORD`。push main 即完成一切：CI 自动查找/创建 D1 库并回填 ID → deploy → 同步密码。打开 `https://<worker 域名>/health` 见 `"healthy":true` 即上弦，根路径进面板。

本地：`cp .dev.vars.example .dev.vars`（密码 dev123456）→ `npx wrangler dev`。

## ctx 契约

```js
// src/tasks/xxx.js —— 新增脚本 = 写这个文件 + builtins.js 注册一行 + push
export async function run(ctx) {
  ctx.params               // 任务参数（面板配置）
  ctx.log(msg)             // 写日志（每任务环形 200 行）
  ctx.notify(title, body)  // TimelyNotify 推送；未配密钥自动跳过
  ctx.fetch(url, init)     // 30s 超时的 fetch
}
```

内置脚本示例见 [src/tasks/](src/tasks/)（GLaDOS 签到 / DNSHE 续期），针对免费版 Worker
做了两件事：50 个子请求上限的预算计数——逼近上限时脚本返回 `{ defer: params }`，
runner 自动创建 60 秒后的补跑任务只处理剩余项（跑完自删），今天的签到今天补完；
墙钟熔断分场景（定时 240s / 手动 90s），长节流脚本不误杀。

## 开发

```
npm test                           # 31 调度 + 6 DNSHE + 3 GLaDOS + 6 通知（全 mock）
powershell tools/smoke.ps1         # 上项 + 全源码语法检查
powershell tools/dev-interact.ps1  # 需先 wrangler dev：25 项 API 交互回归
```
