# 青龙

个人定时任务面板，跑在 Cloudflare Workers 免费号上：D1 存任务/日志/设置，
Durable Object 每小时心跳调度，cron 与 /health 只当看门狗。任务脚本以 ES 模块
内置在仓库里（Workers 禁止运行时编译字符串），面板负责编排：选脚本、定节奏、看日志。

```
面板 public/（纯静态，零依赖）──/api/*──▶ Worker src/index.js（鉴权 + CRUD + cron 看门狗）
                                              │
                                    TaskScheduler DO（真调度：alarm 心跳自续期）
                                              │
                                    D1：tasks / logs / settings（首访自动建表播种）
```

## 部署（全自动，只配 Secrets）

GitHub 仓库 Settings → Secrets and variables → Actions：

| Secret | 必填 | 说明 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | ✅ | 模板 "Edit Cloudflare Workers"，**额外附加 D1 编辑权限**（自动建库要用） |
| `CLOUDFLARE_ACCOUNT_ID` | ✅ | 账号 ID（Cloudflare 仪表盘首页可见） |
| `PANEL_PASSWORD` | 可选 | 配置后每次部署自动同步为面板密码 |

push main 即完成一切：CI 自动查找/创建 D1 库并回填 ID → `wrangler deploy` → 同步密码。
打开 `https://<worker 域名>/health` 看到 `"healthy":true` 即完成上弦，根路径进面板。

本地开发：`copy .dev.vars.example .dev.vars`（预置密码 dev123456）→ `npx wrangler dev`。

## 任务脚本（ctx 契约）

```js
// src/tasks/xxx.js —— 新增脚本 = 写这个文件 + builtins.js 注册一行 + push
export async function run(ctx) {
  // ctx.params              任务参数（键值对）
  // ctx.log(msg)            写运行日志（面板可查，每任务保留最近 200 行）
  // ctx.notify(title, body) 全局推送（面板"通知设置"里配密钥；留空则跳过）
  // ctx.fetch(url, init)    带超时保险丝的 fetch（单请求 30s）
}
```

每任务限时 90 秒，单次运行推送上限 10 次。时间按北京时间（`TZ_OFFSET` 可调，默认 +8）。
心跳每小时扫一次到期任务，串行执行；错过的补跑一次并追到最新档；手动运行不打乱节奏。
单次天/月任务执行后按规则重算锚点（`computeNext`，不累积漂移），心跳期再由 `healedAnchor`
纠正历史漂移值。

## 回归

```powershell
powershell -ExecutionPolicy Bypass -File tools\smoke.ps1
```

含调度数学 20 个单元测试、DNSHE 6 个 mock 端到端、GLaDOS 3 个、通知 6 个 + 全部语法检查。

## 目录

```
src/            Worker：index.js(API) · auth.js(签名Cookie) · scheduler.js(DO)
                runner.js(执行器) · nextrun.js(调度数学) · notify.js(TimelyNotify)
                seed.js(建表播种) · coordinator.js(单飞锁) · builtins.js(注册表)
src/tasks/      内置脚本：glados-checkin.js · dnshe-renew.js
public/         面板：app.js(视图) · components.js(组件) · api.js(数据层) · style/ 四拆
tools/          smoke.ps1 回归入口 · test-*.mjs 单测 · upload.ps1 推送 · cpu-bench.mjs
reference/      原始实现对照基线（线上失败时逐行比对排错用，刻意保留）
```
