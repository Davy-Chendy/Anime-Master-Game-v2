# 动漫高手·一眼顶针

多人实时动画截图猜番小游戏。房主创建房间并选择本局出题人，出题人准备截图题库，房主开始游戏，玩家根据逐块揭露的图片猜动画名，最后进入排行榜结算。

生产部署推荐给 Cloudflare Pages 绑定自定义域名，并把 Worker 配到同源 `/api/*` 路由。

## 怎么玩

### 创建或加入房间

1. 打开网站。
2. 输入昵称。
3. 创建房间，或输入 6 位房间号加入朋友的房间。
4. 房主在大厅中选择一名玩家作为本局出题人。

### 准备题库

出题人可以选择一种方式准备题库：

- 上传本地图片或整个文件夹。
- 粘贴图片 URL 文本。
- 导入 JSONL 文件。
- 选择社区题库。

题库准备完成后，房主会看到“开始游戏”按钮变为可用。房主点击后，本局游戏正式开始。

### 游戏过程

- 每张图片会被切成 45 块，逐轮揭露。
- 出题人能看到原图和网格，选择本轮要揭露的块。
- 玩家根据已揭露部分提交答案。
- 出题人打开判分面板，勾选答对的玩家。
- 越早答对，得分越高。
- 题库全部完成后进入排行榜。

### 出题工具

首页和房间页都有“我要出题”入口。弹窗里可以打开动画截图工具，快速整理截图，再回到游戏中上传或导入题库。

## 功能

- 多人房间和实时同步。
- 房主选择出题人。
- 上传图片、URL / JSONL 导入、社区题库选择。
- 45 块图片揭露，支持横屏和竖屏截图。
- 倒计时答题。
- 出题人判分。
- 排行榜结算。
- 题库发布到社区、搜索、预览和评分。
- 刷新后恢复当前房间和游戏状态。

## 技术栈

- Vite static build for Cloudflare Pages
- React 18
- TypeScript
- Tailwind CSS
- Cloudflare Pages
- Cloudflare Workers + Durable Objects
- Cloudflare D1
- Cloudinary unsigned browser upload

## 部署

部署自己的版本请看：

[docs/deployment.md](docs/deployment.md)

## 维护

测试数据清理 SQL：

[docs/maintenance-cleanup.md](docs/maintenance-cleanup.md)
