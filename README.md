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
│   └── assets/  style.css / app.js / api.js
├── src/
│   ├── index.js            # Worker：API 路由 + 鉴权 + cron 看门狗 + /api/builtins
│   ├── scheduler.js        # TaskScheduler DO：小时心跳 + 单飞锁
│   ├── runner.js           # 执行器：内置库直调 / ctx 注入 / 限时 / 崩溃恢复 / 日志落库
│   ├── builtins.js         # 内置任务库注册表（key -> {name, params, run}）
│   ├── tasks/
│   │   ├── glados-checkin.js   # GLaDOS 签到（≥500 分自动兑换）
│   │   └── dnshe-renew.js      # DNSHE 域名续期
│   ├── nextrun.js          # 北京时间锚定的 next_run_at 计算
│   ├── notify.js           # MeoW 全局推送（api.chuckfang.com）
│   ├── seed.js             # D1 建表/迁移 + 内置任务播种（原子认领防竞态）
│   └── coordinator.js      # 单飞协调器（移植自 UptimeFlare）
├── reference/              # 移植参考（GLaDOS / DNSHE 原脚本、UptimeFlare 调度源码）
├── tools/
│   ├── smoke.ps1           # 回归入口：21 个测试 + 全部语法检查
│   ├── test-nextrun.mjs / test-dnshe.mjs / test-glados.mjs
│   ├── cpu-bench.mjs       # 纯 JS CPU 基准（对账 Workers 10ms 预算）
│   ├── live-run.mjs / run-live.ps1   # 真实凭据试跑（凭据走环境变量，不入库）
│   ├── ci-log.ps1          # 拉取 Actions 运行日志排错
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
面板必须连接后端才能工作（演示模式已移除），本地调样式一律走 `wrangler dev`。

## 本地开发

```powershell
npm install
copy .dev.vars.example .dev.vars   # 已预置本地开发密码 dev123456
npx wrangler dev                   # 本地完整跑（DO/D1 均为本地模拟）
```

回归检查：`powershell -ExecutionPolicy Bypass -File tools\smoke.ps1`
（含调度数学 12 个单元测试、DNSHE 移植 6 个 mock 端到端测试 + 全部 JS 语法检查。）

## 脚本契约与内置任务库

任务脚本以 **ES 模块**形式放在 `src/tasks/` 并在 `src/builtins.js` 注册，随构建打包后原生执行。
面板不存脚本文本——因为 **Workers 运行时禁止字符串编译**（`new Function`/`eval`，平台安全模型，
免费付费一致），这也是"面板贴任意脚本直接跑"在 Cloudflare 上做不到的原因。

```js
export async function run(ctx) {
  // ctx.params  任务的参数（键值对）
  // ctx.log(msg)                      写入运行日志
  // ctx.notify(title, content)        全局 MeoW 推送（面板里配置昵称）
  // ctx.fetch(url, init)              带超时保险丝的 fetch
}
```

- 每任务限时 90 秒，`ctx.fetch` 单请求限时 30 秒，超时只影响本任务，不影响其他任务。
- 日志每任务保留最近 200 行，写入即环形截断；单次运行推送上限 10 次。
- 心跳每小时一次：扫 `next_run_at <= now` 的启用任务，串行执行；
  错过的补跑一次并把锚点追到未来最新一档；手动运行不打乱原节奏。
- 时间按北京时间（`TZ_OFFSET` 变量可调，默认 +8）。

### 添加新脚本（三步）

1. 让 AI 按上面的 ctx 契约生成 `export async function run(ctx) {...}`，存为 `src/tasks/xxx.js`；
2. 在 `src/builtins.js` 注册一行：`'xxx': { name: '显示名', params: ['参数键'], run: xxx.run }`；
3. push → 自动部署 → 面板新建任务时即可选到。


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
