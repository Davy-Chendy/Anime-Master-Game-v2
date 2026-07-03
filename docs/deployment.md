# 部署指南

当前架构：

- 前端：Cloudflare Pages
- 后端 API + WebSocket：Cloudflare Workers
- 实时房间：Durable Objects
- 持久化：Cloudflare D1
- 图片：Cloudflare R2
- 远端 URL 图片压缩：Cloudflare Images binding

生产环境推荐使用自定义域名同源路由：

```text
https://game.example.com        -> Pages 前端
https://game.example.com/api/*  -> Worker API 和 WebSocket
```

同源路由可以让页面、HTTP API 和 WebSocket 都走同一个 origin，减少 CORS 预检和跨域代理链路差异。跨域 `workers.dev` API 地址只建议用于首次联调或没有自定义域名的临时部署。

目录：

- [本地开发](#本地开发)
- [Cloudflare 部署](#cloudflare-部署)
- [更新部署](#更新部署)
- [常见问题](#常见问题)

## 本地开发

安装依赖：

```bash
npm install
```

复制环境变量：

```bash
cp .env.example .env.local
```

本地前端至少需要：

```env
NEXT_PUBLIC_API_BASE_URL=http://localhost:8787
```

图片上传会走本地 Worker 的 R2 绑定。首次运行前先创建本地 D1，并确认 `wrangler.toml` 里有 `IMAGE_BUCKET` 绑定：

```toml
[[r2_buckets]]
binding = "IMAGE_BUCKET"
bucket_name = "anime-master-game-images"
```

初始化本地 D1：

```bash
npm run d1:migrate:local
```

开两个终端：

```bash
npm run worker:dev
```

```bash
npm run dev
```

默认地址：

```text
前端：http://localhost:3000
Worker：http://localhost:8787
```

本地检查：

```bash
npm run lint
npm run worker:typecheck
npm run build
```

## Cloudflare 部署

第一次部署顺序：

1. 创建 D1。
2. 创建 R2 bucket。
3. 填 `wrangler.toml`。
4. 执行远程 D1 迁移。
5. 部署 Worker：本地手动部署或 Git 连接部署二选一。
6. 连接 GitHub 自动部署 Pages。
7. 绑定自定义域名，并配置 Worker 同源 `/api/*` route。
8. 回填真实 `ALLOWED_ORIGIN`，按你的 Worker 部署方式更新 Worker。
9. 删除 Pages 的 `NEXT_PUBLIC_API_BASE_URL`，重新部署 Pages。

### 1. 创建 D1

登录 Cloudflare：

```bash
npx wrangler login
```

创建远程 D1：

```bash
npx wrangler d1 create anime_master_game
```

把输出里的 `database_id` 填入 `wrangler.toml`。注意 `binding` 必须是 `DB`，因为 Worker 代码读取的是 `env.DB`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "anime_master_game"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
migrations_dir = "d1/migrations"
```

第一次部署时还没有 Pages 地址，`ALLOWED_ORIGIN` 先临时写成 `"*"`：

```toml
[vars]
ALLOWED_ORIGIN = "*"
R2_IMAGE_PREFIX = "question-images"
R2_EXISTING_IMAGE_LIMIT = "50"
```

### 2. 创建 R2 bucket

创建远程 R2 bucket：

```bash
npx wrangler r2 bucket create anime-master-game-images
```

确认 `wrangler.toml` 里的 binding 名称是 `IMAGE_BUCKET`。Worker 代码通过绑定直接读写 R2，不需要 R2 API token，也不要把 Cloudflare API token 写进代码或配置：

```toml
[[r2_buckets]]
binding = "IMAGE_BUCKET"
bucket_name = "anime-master-game-images"

[images]
binding = "IMAGES"
```

执行远程 D1 迁移：

```bash
npm run d1:migrate:remote
```

### 3. 部署 Worker

先检查 Worker：

```bash
npm run worker:typecheck
npx wrangler deploy --dry-run
```

#### 方式 A：本地手动部署

部署 Worker：

```bash
npm run worker:deploy
```

部署成功后，记下 Worker 地址：

```text
https://anime-master-game-api.<your-name>.workers.dev
```

#### 方式 B：Git 连接部署

把代码和 `wrangler.toml` push 到 GitHub。

在 Cloudflare 创建 Worker：

```text
Account home -> Add -> Workers
```

选择连接 GitHub 仓库，填写：

```text
Project name: anime-master-game-api
Root directory: 项目根目录
Build command: 留空
Deploy command: npx wrangler deploy
```

如果页面可以选择 production branch，就选 `main` 或你的实际生产分支。如果创建页面没有分支选项，先继续创建，部署后到这里确认或调整：

```text
Workers & Pages -> 你的 Worker -> Settings -> Builds
```

Worker 名称要和 `wrangler.toml` 一致：

```toml
name = "anime-master-game-api"
```

部署成功后，记下 Worker 地址：

```text
https://anime-master-game-api.<your-name>.workers.dev
```

### 4. 部署 Pages

在 Cloudflare 创建 Pages：

```text
Account home -> Add -> Pages
```

连接 GitHub 仓库，构建配置：

```text
Framework preset: None / No preset
Build command: npm run build
Build output directory: pages-dist
Root directory: 项目根目录
```

如果还没有配置同源 `/api/*`，在 `Environment variables (advanced)` 添加临时跨域 API 地址：

```env
NEXT_PUBLIC_API_BASE_URL=https://anime-master-game-api.<your-name>.workers.dev
```

如果已经配置了自定义域名同源 `/api/*`，不要配置 `NEXT_PUBLIC_API_BASE_URL`。

不要把 `NEXT_PUBLIC_API_BASE_URL` 保留为空字符串；直接删除这个环境变量。

其他前端上传参数已有默认值，通常不用填：

```text
NEXT_PUBLIC_UPLOAD_IMAGE_MAX_SIZE=1600
NEXT_PUBLIC_UPLOAD_IMAGE_FORMAT=image/webp
NEXT_PUBLIC_UPLOAD_IMAGE_QUALITY=0.78
NEXT_PUBLIC_R2_UPLOAD_CONCURRENCY=2
```

保存后 Cloudflare Pages 会自动构建并部署。部署成功后，记下 Pages 地址：

```text
https://anime-master-game-v2.pages.dev
```

### 5. 回填 CORS

把 `wrangler.toml` 里的 `ALLOWED_ORIGIN` 从 `"*"` 改成真实 Pages origin：

```toml
ALLOWED_ORIGIN = "https://anime-master-game-v2.pages.dev"
```

不要带结尾 `/`：

```text
正确：https://anime-master-game-v2.pages.dev
错误：https://anime-master-game-v2.pages.dev/
```

然后更新 Worker：

```bash
# 本地手动部署：
npm run worker:deploy

# Git 连接部署：
git push
```

### 6. 推荐：自定义域名同源 `/api/*`

生产环境推荐做成：

```text
https://game.example.com        -> Pages 前端
https://game.example.com/api/*  -> Worker API 和 WebSocket
```

这样 API 和页面同源，可以减少 CORS `OPTIONS`，也能避免跨域 Worker 地址、Pages 地址和浏览器 WebSocket 行为不一致导致的实时同步问题。

步骤：

1. 给 Pages 绑定自定义域名：

```text
Workers & Pages -> 你的 Pages 项目 -> Custom domains -> Set up a domain
```

2. 给 Worker 添加 route：

```text
Workers & Pages -> 你的 Worker -> Domains -> Add domain -> Route pattern
```

Route pattern：

```text
game.example.com/api/*
```

不要选择 `Custom Domains`，这里要选 `Route pattern`，因为前端根路径仍然由 Pages 提供，只有 `/api/*` 交给 Worker。

如果输入框里默认出现类似下面的通配 pattern，不要直接使用：

```text
*.example.com/*
```

它会把整站流量都交给 Worker，可能导致 Pages 前端打不开。只填写当前前端域名下的 `/api/*`：

```text
game.example.com/api/*
```

例如你的前端域名是 `anipeek.animaster.dpdns.org`，就填写：

```text
anipeek.animaster.dpdns.org/api/*
```

3. 删除 Pages 环境变量：

在 Pages 项目的 `Settings -> Environment variables` 里删除 `NEXT_PUBLIC_API_BASE_URL`。

如果 Cloudflare Pages 界面或现有流程必须保留这个变量，就填自定义域名的 origin，不要带 `/api`：

```env
NEXT_PUBLIC_API_BASE_URL=https://game.example.com
```

不要填：

```env
NEXT_PUBLIC_API_BASE_URL=https://game.example.com/api
NEXT_PUBLIC_API_BASE_URL=/api
```

保存后，在 Pages 的 `Deployments` 里重新运行最近一次 Git deployment。

4. Worker 的 `ALLOWED_ORIGIN` 改成：

```toml
ALLOWED_ORIGIN = "https://game.example.com"
```

然后更新 Worker：

```bash
# 本地手动部署：
npm run worker:deploy

# Git 连接部署：
git push
```

5. 检查生产页面的 API 地址：

打开浏览器开发者工具，确认请求和 WebSocket 都是同源地址：

```text
https://game.example.com/api/rpc
wss://game.example.com/api/realtime/room%3A.../ws
```

如果仍然看到 `https://anime-master-game-api.<your-name>.workers.dev` 或 `wss://anime-master-game-api.<your-name>.workers.dev`，说明 Pages 还在使用旧的 `NEXT_PUBLIC_API_BASE_URL`，需要删除该环境变量并重新部署 Pages。

## 更新部署

只改前端：

```bash
git push
```

Cloudflare Pages 会自动构建和部署。

只改 Worker 或 `wrangler.toml`：

```bash
# 本地手动部署：
npm run worker:deploy

# Git 连接部署：
git push
```

改了 D1 迁移：

```bash
npm run d1:migrate:remote

# 本地手动部署：
npm run worker:deploy

# Git 连接部署：
git push
```

前后端都改了：

- 如果接口兼容，更新 Worker，并 push 前端。
- 如果新前端依赖新后端，先更新 Worker，确认 Worker 部署完成后，再 push 前端。

改了 Pages 环境变量：

```text
Pages -> Deployments -> 重新运行最近一次 Git deployment
```

改了 R2 bucket 名称或绑定后，先更新 `wrangler.toml`，再重新部署 Worker。

## 常见问题

### 找不到 Pages 创建入口

新版入口：

```text
Account home -> Add -> Pages
```

如果从旧入口进入：

```text
Workers & Pages -> Create application
```

默认可能是 Create Worker 页面。不要在这里创建 Pages，找到页面下方：

```text
Looking to deploy Pages? Get started
```

点击 `Get started` 进入 Pages。

### Framework preset 没有 Vite

没关系，preset 不是必须。选：

```text
Framework preset: None / No preset
```

然后手动填：

```text
Build command: npm run build
Build output directory: pages-dist
```

### 页面操作提示 Failed to fetch

优先检查两处。

第一，Worker 的 `ALLOWED_ORIGIN` 必须和浏览器地址栏 origin 精确一致，不能带结尾 `/`：

```toml
ALLOWED_ORIGIN = "https://anime-master-game-v2.pages.dev"
```

第二，Pages 的 `NEXT_PUBLIC_API_BASE_URL`：

- 跨域 Worker 模式：填 Worker 地址。
- 同源 `/api/*` 模式：删除这个环境变量。
- 如果界面或流程必须保留变量：填自定义域名 origin，例如 `https://game.example.com`，不要带 `/api`。
- 不要填 `localhost`。
- 跨域 Worker 模式不要填 Pages 地址；同源模式只在必须保留变量时填自定义域名 origin。

改完 Worker 配置后执行：

```bash
# 本地手动部署：
npm run worker:deploy

# Git 连接部署：
git push
```

改完 Pages 环境变量后，在 Pages 的 `Deployments` 里重新运行最近一次 Git deployment。

### 多浏览器游戏内状态不同步

现象：房主点击开始游戏、返回大厅能同步，但揭露方块、下一题、判分后玩家端不动，刷新后才显示最新状态。

优先检查生产环境是否使用同源 `/api/*`：

```text
推荐：https://game.example.com/api/*
临时：https://anime-master-game-api.<your-name>.workers.dev
```

如果已经有自定义域名，按“推荐：自定义域名同源 `/api/*`”配置：

- Worker route pattern：`game.example.com/api/*`，不要使用 `*.example.com/*`
- Pages 删除 `NEXT_PUBLIC_API_BASE_URL`
- Worker `ALLOWED_ORIGIN = "https://game.example.com"`
- 重新部署 Worker 和 Pages

同时确认 Cloudflare 没有给 `/api/*` 配缓存规则，Network 里的 WebSockets 功能处于开启状态。

### 线上提示数据库表不存在

执行远程 D1 迁移：

```bash
npm run d1:migrate:remote
```

### 图片上传后无法显示

先检查 Worker 是否绑定了 R2：

```toml
[[r2_buckets]]
binding = "IMAGE_BUCKET"
bucket_name = "anime-master-game-images"
```

再检查图片 URL 是否走到了 Worker：

```text
https://game.example.com/api/r2-images/question-images/...
```

如果你配置了 `R2_PUBLIC_BASE_URL`，需要确保该域名已经绑定到 R2 bucket，且浏览器可以直接访问对象。
