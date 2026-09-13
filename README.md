# 行间 · Travel Assistant

旅行计划、笔记、地图、关键卡片和同行共享工作区。功能服务与 Agent 是两个独立进程：Agent 离线时，已保存资料、手动编辑、共享和撤销仍可使用。

## Mac 一键安装

先安装 Git（macOS 首次运行 `git` 会提示安装命令行工具）。在终端执行一行：

```sh
git clone https://github.com/zzr0908/travelAsistant.git && cd travelAsistant && bash scripts/install.sh
```

安装器准备独立的官方 Node 24.13.0、锁定版本的依赖与 Harness，构建项目，再创建两个 macOS LaunchAgent。首次下载和构建需要联网，可能需要数分钟。之后登录系统自动启动，无须保持终端打开。研究浏览器使用本机 Chrome；需要 Chrome 149 或更高版本。

打开 [http://localhost:4317](http://localhost:4317)。首次创建管理员时，输入以下命令显示的安装凭据：

```sh
"$HOME/Library/Application Support/TravelAssistant/travel" setup-token
```

安装目录为 `~/Library/Application Support/TravelAssistant`：`data/` 保存业务数据，`agent-data/` 保存浏览器运行资料，`config/local.env` 保存模型配置，`logs/` 分别保存两个服务的日志。安装器不导入当前开发目录中的数据库，也不包含私人验收资料。

修改 `config/local.env` 的 `ZHIPU_API_KEY` 可启用研究；卡片提取可单独设置 `CARD_API_KEY`，本地未设置时使用普通 `ZHIPU_API_KEY`。无密钥也能手动规划与填写卡片。Coding key 仅用于显式开发模式。

```sh
"$HOME/Library/Application Support/TravelAssistant/travel" restart
"$HOME/Library/Application Support/TravelAssistant/travel" status
"$HOME/Library/Application Support/TravelAssistant/travel" logs agent
```

## Docker 部署

Mac 安装并启动 Docker Desktop，Linux 安装 Docker Engine 和 Compose。在项目目录执行：

```sh
docker compose up -d --build --wait
```

两个容器分别运行 `app` 和 `agent`。业务数据只挂载到 app；Agent 只获得自身运行目录和服务凭据。默认只公开本机 4317 端口，内部 4319 与健康检查 4318 不发布到宿主机。

首次设置凭据：

```sh
docker compose exec app cat /data/private/setup-token
```

将 `.env.example` 复制为 `.env`，按需要填写 `ZHIPU_API_KEY`、`CARD_API_KEY` 后重新执行 Compose 命令。Docker 的两类模型凭据分别配置。浏览器由 Agent 容器内 Chromium 执行。

云端使用 HTTPS 反向代理，并设置 `PUBLIC_URL=https://你的域名`、准确的 `TRUST_PROXY`；需要外部直接访问时设置 `BIND_HOST=0.0.0.0`。不要发布内部服务端口。

```sh
docker compose logs -f app agent
docker compose down
```

`down` 保留数据卷；`down -v` 会删除数据，不用于常规升级。

## 分别开发

```sh
node scripts/bootstrap.mjs        # 安装依赖，准备固定 Harness，构建
npm start                         # 前台同时运行两个服务，Ctrl+C 一并退出
npm run start:app                  # 单独运行功能服务
npm run start:agent                # 单独运行 Agent，需配置服务凭据文件
npm run build:app                  # 功能服务与前端
npm run build:agent                # Agent 运行代码
npm run dev                       # 功能服务源码监听
npm run dev:agent                 # 无模型 Worker 源码监听
```

单独运行 Agent 时设置 `TRAVEL_SERVICE_TOKEN_FILE` 指向功能服务自动生成的 `data/config/service-token`，并设置 `APP_INTERNAL_URL`。完整 Harness 的策略修改后运行 `npm run build:agent && npm run start:agent`。显式 Coding 模式使用 `npm run start:agent:dev`。

| 目录 | 职责 |
| --- | --- |
| `src/service/`、`src/cards/`、`src/maps/` | 页面 API、权限、计划、研究记录、提议、卡片、地图 |
| `src/storage/`、`src/execution/` | SQLite、迁移、备份、执行任务与内部接口 |
| `src/agent/runtime/`、`src/agent/browser/` | 研究策略、Worker、浏览器运行 |
| `config/harness/worker/` | Harness 接入、通过 HTTP 写入研究日志 |
| `src/shared/` | 两边使用的协议和数据类型 |

同一仓库便于同步接口，但两个服务分别构建、启动和部署。旧 `src/agent/service.ts` 等入口只保留兼容导出，新业务开发使用 `src/service/research/`。

## 回归与备份

```sh
npm run check
npm test
npm run build
npm run test:services
node scripts/verify-runtime.mjs
```

默认回归使用受控模型和浏览器替身，不发送付费模型或地图查询。真实 Harness 启动与日志持久化另行验证。GitHub CI 在 Linux/macOS 跑回归，并在 Linux 构建、启动两个 Docker 容器。

数据库版本为 8，旧版本 1—7 自动迁移；不修改已有旅行、卡片和历史提议。中断的研究不会自动重新调用模型。升级前备份，回滚旧程序时也必须恢复兼容的旧备份。

```sh
"$HOME/Library/Application Support/TravelAssistant/travel" backup /完整路径/travel.db
"$HOME/Library/Application Support/TravelAssistant/travel" stop
"$HOME/Library/Application Support/TravelAssistant/travel" restore /完整路径/travel.db
"$HOME/Library/Application Support/TravelAssistant/travel" start
```

源码运行可用 `DATA_DIR=... npm run backup -- /完整路径/备份.db`，恢复前停止服务后执行 `npm run restore -- /完整路径/备份.db`。备份不含模型密钥和浏览器登录状态。

更多实现与验收说明见 [双服务说明](docs/deployment.md) 和 [回归记录](docs/two-service-regression.md)。
