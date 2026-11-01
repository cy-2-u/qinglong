# 青龙 · Workers 版

类似青龙面板的定时任务管理器，跑在 Cloudflare Workers 免费号上：
D1 存任务/脚本/日志，Durable Object 做每小时心跳调度，任务脚本用 JS 编写，面板零依赖零构建。

```
┌─ 面板 public/（Workers Static Assets）──────────┐
│ 任务列表 / 编辑器（时|天|月滑块）/ 脚本导入 / 日志 │
└────────────────┬───────────────────────────────┘
                 │ /api/*（HMAC Cookie 鉴权）
┌─ Worker src/index.js ──────────────────────────┐
│ /health 上弦 + cron 看门狗（每小时）             │
└────────────────┬───────────────────────────────┘
                 │
┌─ TaskScheduler DO（真调度）────────────────────┐
│ alarm() 心跳 → 扫到期任务 → 串行执行 → 续闹钟    │
└──────┬─────────────────────────────────────────┘
       │ D1：tasks / logs / settings（自动建表+播种）
```

调度可靠性沿用 UptimeFlare 的模式（见 `reference/uptimeflare_*.ts`）：
cron 与 /health 只负责 `ensureAlarm()`，真调度是 DO alarm 自续期；先上弦再干活，
单轮崩溃不影响下一班；手动运行与心跳共用单飞锁。

## 目录结构

```
qinglong/
├── public/                 # 面板（纯静态，零依赖）
│   ├── index.html
│   └── assets/  style.css / app.js / api.js / mock.js
├── src/
│   ├── index.js            # Worker：API 路由 + 鉴权 + cron 看门狗
│   ├── scheduler.js        # TaskScheduler DO：小时心跳 + 单飞锁
│   ├── runner.js           # 脚本执行器：编译缓存/ctx 注入/限时/崩溃恢复/日志落库
│   ├── nextrun.js          # 北京时间锚定的 next_run_at 计算
│   ├── notify.js           # MeoW 全局推送（api.chuckfang.com）
│   ├── seed.js             # D1 建表 + 内置脚本播种（原子认领防竞态）
│   ├── coordinator.js      # 单飞协调器（移植自 UptimeFlare）
│   └── scripts/
│       ├── glados-checkin.txt   # 内置脚本：GLaDOS 签到（完整移植，≥500 分自动兑换）
│       └── dnshe-renew.txt      # 内置脚本：DNSHE 域名续期（完整移植）
├── reference/              # 移植参考（GLaDOS / DNSHE 原脚本、UptimeFlare 调度源码）
├── tools/
│   ├── smoke.ps1           # 回归入口：21 个测试 + 全部语法检查
│   ├── test-nextrun.mjs / test-dnshe.mjs / test-glados.mjs
│   ├── cpu-bench.mjs       # 纯 JS CPU 基准（对账 Workers 10ms 预算）
│   ├── live-run.mjs / run-live.ps1   # 真实凭据试跑（凭据走环境变量，不入库）
│   ├── serve.mjs           # 面板本地静态预览（演示模式）
│   └── upload.ps1          # 无 git 环境的增量推送（delete-list.txt 声明远程删除项）
├── wrangler.toml
└── .github/workflows/deploy.yml
```

## 部署到 Cloudflare（全自动，只需配 Secrets）

在 GitHub 仓库 Settings → Secrets and variables → Actions 配置后，push main 即完成一切：

| Secret | 必填 | 说明 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | ✅ | 模板 "Edit Cloudflare Workers"，**额外附加 D1 编辑权限**（自动建库要用） |
| `CLOUDFLARE_ACCOUNT_ID` | ✅ | 账号 ID（Cloudflare 仪表盘首页可见） |
| `PANEL_PASSWORD` | 可选 | 配置后每次部署自动同步为面板密码；不配则用 `wrangler secret put` 设置过的 |

CI 流程（`.github/workflows/deploy.yml`）：

1. 通过 API **查找或创建**名为 `qinglong` 的 D1 库，自动回填 ID（`wrangler.toml` 里的全零占位符无需手动改）
2. `wrangler deploy`：静态资源 + DO migration + cron trigger 一次完成
3. 若配置了 `PANEL_PASSWORD` Secret，自动同步为 Worker 密码

部署完成后打开 `https://qinglong.<你的子域>.workers.dev/health`，看到 `"healthy":true`
即完成上弦；再打开根路径进入面板。任务表与内置脚本在首次访问时自动创建/播种。

本地手动部署（可选）：`npx wrangler login && npx wrangler deploy`；
本地开发 `npx wrangler dev`（D1/DO 均为本地模拟，占位符 ID 可直接用）。

## 本地开发

```powershell
npm install
copy .dev.vars.example .dev.vars   # 已预置演示密码 dev123456
npx wrangler dev                   # 本地完整跑（DO/D1 均为本地模拟）
```

只调面板样式时不用起 Worker：`node tools/serve.mjs` 后访问 http://127.0.0.1:8137/（演示模式，数据存 localStorage）。

回归检查：`powershell -ExecutionPolicy Bypass -File tools\smoke.ps1`
（含调度数学 12 个单元测试、DNSHE 移植 6 个 mock 端到端测试 + 全部 JS 语法检查。）

## 脚本契约

```js
async function main(ctx) {
  // ctx.params  任务的参数（键值对）
  // ctx.log(msg)                      写入运行日志
  // ctx.notify(title, content)        全局 MeoW 推送（面板里配置昵称）
  // ctx.fetch(url, init)              带超时保险丝的 fetch
}
```

- 每任务限时 90 秒，`ctx.fetch` 单请求限时 30 秒，超时只影响本任务，不影响其他任务。
- 日志每任务保留最近 200 行，写入即环形截断。
- 心跳每小时一次：扫 `next_run_at <= now` 的启用任务，串行执行；
  错过的补跑一次并把锚点追到未来最新一档；手动运行不打乱原节奏。
- 时间按北京时间（`TZ_OFFSET` 变量可调，默认 +8）。

### 任务头规范（AI 写脚本时贴这段）

```js
// ==qinglong==
// name: GLaDOS 签到
// unit: d        // h=小时级 / d=天级 / m=月级
// amount: 1      // 每 N 个单位
// hour: 9        // unit 为 d/m 时：北京时间几点（0-23）
// day: 1         // unit 为 m 时：每月几号（1-28）
// params: cookie // 参数名清单，值在面板里填
// ==/qinglong==

async function main(ctx) {
  // ...
}
```

面板编辑器的「导入脚本」支持粘贴 / 本地文件 / 拖拽，带任务头的脚本自动填充表单。

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/login | 登录，30 天签名 Cookie |
| GET/POST | /api/tasks | 列表 / 新建 |
| PUT/PATCH/DELETE | /api/tasks/:id | 修改 / 启停 / 删除 |
| POST | /api/tasks/:id/run | 手动运行 |
| GET | /api/tasks/:id/logs | 最近 200 条日志 |
| GET/PUT | /api/settings | MeoW 昵称 |
| POST | /api/settings/test | 测试推送 |
| GET | /health | 公开自暴露（可挂到任意拨测监控） |

## 路线图

- [x] 面板 UI（列表 / 编辑器 / 导入 / 日志 / 通知设置）
- [x] Worker 后端（API + 鉴权 + D1 + DO 心跳 + 脚本执行器）
- [x] GLaDOS 签到脚本移植
- [x] DNSHE 域名续期脚本完整移植（含 mock 端到端测试 `tools/test-dnshe.mjs`）
- [ ] 面板在线编辑体验增强（语法高亮等，可选）
