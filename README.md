# QingLong Panel · 青龙面板

个人定时任务面板，部署在 [Cloudflare Workers](https://workers.cloudflare.com/) 免费档：
D1 存储 + Durable Object 闹钟调度 + 内置任务库 + TimelyNotify 推送。

[![Deploy](https://github.com/cy-2-u/qinglong/actions/workflows/deploy.yml/badge.svg)](https://github.com/cy-2-u/qinglong/actions/workflows/deploy.yml)

设计目标：**零费用、零运维、手机可用**。脚本以 ES 模块随构建打包（Workers 禁止运行时编译字符串），
面板只负责编排：选脚本、定节奏、看日志、收推送。

## 功能

- 调度：北京时间锚点（小时 / 天 / 月，间隔可调），停摆补跑一次并追平；单次天/月任务按规则重算锚点，心跳期自动纠正漂移
- 执行：Durable Object 闹钟对齐最近任务锚点（准点秒级），cron 与 `/health` 只当兜底；单任务限时 90s，日志环形保留 200 行
- 通知：[TimelyNotify](https://timelynotify.oicode.cn) GET 直连，不限出口 IP；未配密钥自动跳过，单次运行上限 10 条
- 面板：纯静态零依赖前端（无构建步骤），HMAC 签名 Cookie 登录，明暗双主题，移动端自适应
- 安全：面板密码即 HMAC 密钥，改密码旧会话全部失效；API 全部走鉴权，`/health` 除外

## 架构

```
cron trigger (每小时) ──► /health ──► DO.ensureAlarm()    兜底重算
                                          │
Durable Object TaskScheduler ◄── alarm ──┘    真调度（闹钟对齐最近任务锚点，1h 兜底）
        │ 单飞锁 RunCoordinator（心跳/手动运行互斥）
        ▼
   heartbeat ──► runner ──► 内置脚本 run(ctx) ──► 日志落 D1（环形 200 行）
        │                            │
        │ computeNext/healedAnchor   └─ ctx.notify ──► TimelyNotify
        ▼
   D1 (tasks / logs / settings)
```

闹钟不是"每小时固定巡逻"，而是每次重算为 `min(最近启用任务的 next_run_at + 5s, now + 1h)`：
任务在锚点后几秒准点执行；任务增删改立即触发重算；无启用任务时退化为每小时看门狗。

## 部署

前置：Cloudflare 账号、GitHub 账号。

1. Fork 或使用本仓库，在 GitHub **Settings → Secrets and variables → Actions** 配置：

| Secret | 必填 | 说明 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | ✅ | 模板 "Edit Cloudflare Workers"，**附加 D1 编辑权限**（自动建库要用） |
| `CLOUDFLARE_ACCOUNT_ID` | ✅ | 账号 ID（Cloudflare 仪表盘首页可见） |
| `PANEL_PASSWORD` | 可选 | 配置后每次部署自动同步为面板密码 |

2. push 到 `main` 即完成一切：CI 自动查找/创建名为 `qinglong` 的 D1 库并回填 ID → `wrangler deploy` → 同步密码。
3. 打开 `https://<worker 域名>/health`，看到 `"healthy": true` 即完成上弦；根路径进面板。

首次进入面板会自动播种两个内置任务（GLaDOS 签到 / DNSHE 续期，参数留空不会运行），
在"推送设置"里配好 TimelyNotify 密钥即可启用推送。

本地开发：

```bash
cp .dev.vars.example .dev.vars   # 预置密码 dev123456
npx wrangler dev                 # 全零占位 D1 ID 即可跑
```

## 任务脚本（ctx 契约）

```js
// src/tasks/xxx.js —— 新增脚本 = 写这个文件 + builtins.js 注册一行 + push
export async function run(ctx) {
  // ctx.params              任务参数（面板里配置的键值对）
  // ctx.log(msg)            写运行日志（面板可查，每任务保留最近 200 行）
  // ctx.notify(title, body) 全局推送（"推送设置"里配密钥；留空则跳过）
  // ctx.fetch(url, init)    带超时保险丝的 fetch（单请求 30s）
}
```

内置脚本示例：[GLaDOS 签到](src/tasks/glados-checkin.js)（多账号、自动兑换 500 积分档）、
[DNSHE 续期](src/tasks/dnshe-renew.js)（分页拉全量、限流节流、按 180 天窗口续期）。

## 开发

```bash
npm test                          # 调度数学 20 + DNSHE 6 + GLaDOS 3 + 通知 6（全程 mock，零真实请求）
powershell tools/smoke.ps1        # 上项 + 全部源码语法检查
powershell tools/dev-interact.ps1 # 需先 npx wrangler dev：登录/CRUD/运行/日志/设置 25 项交互回归
powershell tools/upload.ps1       # 无 git 环境下的替代方案：经 Contents API 推 GitHub（含远程删除清单）
```

提交到 `main` 后 GitHub Actions 自动部署。

## 目录结构

```
src/            Worker
  index.js        API 路由 + cron 看门狗
  auth.js         HMAC 签名 Cookie 鉴权
  scheduler.js    TaskScheduler DO：闹钟自续 + 单飞锁（RunCoordinator）
  runner.js       心跳执行器：限时运行、日志、推送、next_run_at 推进
  nextrun.js      北京锚点调度数学（computeNext / healedAnchor / advanceNext）
  seed.js         D1 建表 + 内置任务播种（原子认领防并发重播）
  notify.js       TimelyNotify 推送客户端（密钥 60s 缓存）
  builtins.js     内置任务注册表
  tasks/          内置脚本（glados-checkin / dnshe-renew）
public/         面板（纯静态，无构建）
  assets/api.js         后端适配层（唯一 HTTP 接口）
  assets/components.js  UI 组件：下拉/分段/弹层/确认/toast
  assets/app.js         视图与事件（登录/列表/编辑器/推送设置/日志）
  assets/style/         tokens(变量) / base(重置) / components / views
tools/          回归与运维脚本（见"开发"一节）
```

## 致谢

- [UptimeFlare](https://github.com/lyc8503/UptimeFlare) — 单飞协调器思路来源
- GLaDOS / DNSHE 脚本分别移植自个人使用的 Python 版本，接口行为经长期生产验证
