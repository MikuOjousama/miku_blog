# MikuFans CMS Worker

MikuFans 的后端 Worker：管理后台 + 文章 API（D1），以及公开 FOREVER 纪念页。
主站 mikufans.site 是 Cloudflare Pages，与本 Worker 无关，不要动它。

## 文件

- `wrangler.toml` — Worker 配置：name `mikufans-cms`，D1 绑定 `DB`（mikufans-content）
- `src/index.js` — Worker 入口，ES Module，无 npm 依赖
- `src/admin.html` — 管理后台单页（内联返回，无外部 CDN）
- `src/forever.html` — 公开 FOREVER 纪念页（内联返回）
- `test-local.mjs` — 本地自测（mock D1，不碰线上）

## 先推到 miku_blog 的 worker/ 目录

```bash
# 在本机（不要在 VM 里直接推 GitHub）
cp -r worker/ /path/to/miku_blog/worker/
cd /path/to/miku_blog
git add worker/
git commit -m "Add MikuFans CMS Worker"
git push origin master
```

## 部署

方式一（推荐，命令行）：

```bash
cd worker
npx wrangler login
npx wrangler deploy
```

方式二（控制台上传）：Cloudflare 控制台 → Workers & Pages → Create → 上传 `src/index.js`、
`src/admin.html`、`src/forever.html`，并按 `wrangler.toml` 配好 D1 绑定（变量名 `DB`）。

部署后先访问 `https://<你的 workers.dev 域名>/api/health`，应返回 `{"ok":true}`。

## 必须设置的 secrets（在控制台设置，绝不要写进代码 / 仓库 / README 的值里）

只写名字和设置方法，不写值：

1. `ADMIN_PASSWORD` — 后台登录密码。
   控制台 → Workers & Pages → mikufans-cms → Settings → Variables → Add variable，
   Type 选 **Secret**，Name 填 `ADMIN_PASSWORD`，Value 填你自己定的强密码，保存。
   未设置时 `/api/login` 返回 503，写操作一律 401，后台页会提示先设置。

2. `MIKU_API_KEY`（可选）— Miku 程序调用写接口用的 key。
   设置方法同上，Name 填 `MIKU_API_KEY`。调用时带请求头 `X-Miku-Key: <你的 key>`。
   不设置也可以，登录 cookie 和 Cloudflare Access 仍可用。

改完 secrets 后要重新部署一次（`wrangler deploy`）才生效。

## 自定义域名（两个都绑同一个 Worker）

在 Cloudflare 控制台 → Workers & Pages → mikufans-cms → Settings → Domains and Routes → Add → Custom Domain，依次添加：

1. `our.mikufans.site` — 根路径就是管理后台
2. `forever.mikufans.site` — 根路径是公开 FOREVER 纪念页，`/admin` 是管理后台

不要只做 CNAME：只做 CNAME 流量不会走到 Worker，必须在 Worker 的 Domains and Routes 里加。

## Cloudflare Access（可选，只放两个人）

1. Cloudflare 控制台 → Zero Trust → Access → Applications → Add an application → Self-hosted
2. Application domain 填 `our.mikufans.site`（如需保护 forever 的后台，也可再加一个 `forever.mikufans.site/admin` 的应用，或用同一个应用加路径规则）
3. Policy：Allow，Include → Emails，填你们两个人的邮箱
4. 保存后，访问后台会先过 Access 登录；Worker 认 `Cf-Access-Jwt-Assertion` 请求头存在即放行（目前不自己验 JWT，后续可加 JWT 验签）

不开 Access 也可以，只用 `ADMIN_PASSWORD` 登录。

## D1 备份提醒

- D1 免费档单库 500MB，文章是纯文本，够用很久，但仍要定期导出备份。
- 导出方法：`npx wrangler d1 export mikufans-content --local=false --output backup.sql`
  或控制台 → D1 → mikufans-content → 导出。
- 建议每月导出一次，存到 Google Drive `miku/记忆备份` 一起备份。

## 路由速查

| Host | `/` | `/admin` |
|---|---|---|
| `our.mikufans.site` | 管理后台 | 管理后台 |
| `forever.mikufans.site` | 公开 FOREVER 纪念页 | 管理后台 |
| 其他（含 workers.dev） | 路由说明页 | 管理后台 |

API 一律 `/api/*`，JSON，CORS 只允许同源。

## 本地自测

```bash
cd worker
node test-local.mjs
```

用内存 mock D1 跑：健康检查、未登录写操作 401、登录错密码 401、登录正确后写 / 读 / 改 / 删 / 发布、公开接口看不到草稿、slug 冲突 409、category 非法 400。
