# MeoW 推送反代

MeoW（api.chuckfang.com）屏蔽 Cloudflare Workers 出口 IP，青龙面板的推送
经本目录部署在 Vercel 上的函数中转（Vercel 出口非 CF 段）。

## 部署（一次性）

```powershell
cd relay
npx vercel login          # 首次登录
npx vercel --prod         # 部署，记下输出的域名（形如 xxx.vercel.app）
```

## 验证

```powershell
# 应返回 {"status":404,...} —— 说明已透传到 MeoW（昵称不存在属预期）
curl.exe -s -X POST "https://<域名>/api/meow/probe_nick" -H "content-type: application/json" -d "{\"title\":\"t\",\"msg\":\"m\"}"
```

## 面板侧

`src/notify.js` 的 `RELAY_BASE` 指向 `https://<域名>/api/meow/` 后 push 即可
（多通道兜底顺序：Vercel 反代 -> down.nigx.cn -> 直连）。
