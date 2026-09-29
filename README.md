# nFileSystem

轻量级自托管文件管理系统，基于 Node.js、Express 和 SQLite，面向单机、单实例部署。

## 主要能力

- 邮箱验证码注册、登录、密码重置和 JWT 鉴权
- 文件夹创建、重命名、移动、递归删除和层级防环
- 文件上传、SHA-256 秒传、下载、预览、搜索和批量操作
- SHA-256 内容寻址与物理去重，同一内容只保留一份物理副本
- 用户权限隔离、配额、磁盘低水位、上传并发限制和认证限流
- 接入应用、独立 API Token、目录隔离和可控访问链接
- SQLite WAL、完整同步、事务、存储校验和孤儿文件清理

## 运行边界

当前版本只支持一个应用实例访问同一组 `data/` 和 `uploads/`。不要让多个容器或 Node.js 进程共享同一个 SQLite 数据库和上传目录。

持久化目录应放在可靠的本地块存储或本机文件系统上，不要直接放在无法保证 SQLite 文件锁、原子重命名和目录同步语义的网络文件系统上。

这是 SHA-256 基线版本，不提供旧 MD5 数据库、API 或物理路径迁移。启动时会接受当前 SHA-256 基线的 v1/v2 数据库，并将 v1 升级到 v2；其他数据库结构会被拒绝。全新部署应使用空的 `data/` 和 `uploads/`。

## 快速开始

环境要求：Node.js 22+，推荐 Node.js 24 LTS。

```bash
npm ci
cp .env.example .env
```

在 `.env` 中配置至少 32 字节、彼此不同的 `JWT_SECRET` 和 `AUTH_CODE_SECRET`，然后启动。生产环境还需配置 SMTP 发件信息；开发环境未配置 SMTP 时，验证码会输出到服务控制台。

```bash
npm start
```

默认地址为 `http://localhost:6001`。开发模式使用 `npm run dev`。

新安装时，先在 `.env` 中将 `ALLOW_REGISTER` 临时设为 `true`，启动后注册首个账号；注册完成再设回 `false` 并重启。模板默认关闭注册，系统不会自动创建账号。

## 配置

完整模板见 `.env.example`，下表列出模板值（复制模板后生效）：

| 变量 | 说明 | 模板值 |
|------|------|--------|
| `PORT` | HTTP 端口 | `6001` |
| `JWT_SECRET` | JWT 签名密钥，至少 32 字节 | 必填 |
| `AUTH_CODE_SECRET` | 邮箱验证码 HMAC 密钥，至少 32 字节 | 必填 |
| `TOKEN_EXPIRES_IN` | 登录 Token 有效期 | `7d` |
| `ALLOW_REGISTER` | 是否开放注册 | `false` |
| `SMTP_HOST` / `SMTP_PORT` | SMTP 服务 | 空 / `587` |
| `SMTP_SECURE` | 是否直接使用 TLS | `false` |
| `SMTP_USER` / `SMTP_PASS` | SMTP 认证 | 空 |
| `MAIL_FROM` | 发件人 | 模板值 |
| `DATA_DIR` | SQLite 数据目录 | `./data` |
| `UPLOAD_DIR` | 文件存储目录 | `./uploads` |
| `MAX_UPLOAD_FILES` | 单次上传文件数 | `20` |
| `MAX_FILE_SIZE_BYTES` | 单文件大小上限 | `52428800` |
| `MAX_UPLOAD_BYTES` | 单次请求总大小上限 | `1048576000` |
| `MAX_UPLOAD_CONCURRENCY` | 并发上传请求数 | `2` |
| `USER_QUOTA_BYTES` | 每用户逻辑配额，`0` 表示不限 | `10737418240` |
| `MIN_FREE_BYTES` | 上传后保留磁盘空间 | `268435456` |
| `DRIVE_PAGE_SIZE` | 目录分页大小 | `200` |
| `MAX_FOLDER_DEPTH` | 最大文件夹深度 | `128` |
| `THUMBNAIL_CONCURRENCY` | 缩略图生成并发数 | `2` |
| `TRASH_RETENTION_DAYS` | 回收站保留天数 | `7` |

`.env` 不应提交到仓库。

若不复制模板，程序内置端口为 `3000`；未设置 `TOKEN_EXPIRES_IN` 时，生产环境登录 Token 有效期为 `2h`，其他环境为 `7d`。

## Docker

本地构建 Docker 镜像并导出为 tar 包：

```bash
npm run build:docker
```

该命令会生成 `n-file-system.tar`，镜像标签为 `n-file-system:latest`。将 tar 包、`docker-compose.yml`、`.env`（由 `.env.example` 复制并填写）以及需要持久化的 `data/`、`uploads/` 目录传到服务端，例如：

```bash
scp n-file-system.tar docker-compose.yml .env user@server:/opt/n-file-system/
```

在服务端加载镜像并启动服务：

```bash
cd /opt/n-file-system
docker load -i n-file-system.tar
docker compose up -d
docker compose ps
```

服务端使用已经加载的 `n-file-system:latest` 镜像，不需要再次构建。更新版本时，在构建机重新执行 `npm run build:docker`，替换服务端 tar 包后再次执行 `docker load -i n-file-system.tar` 和 `docker compose up -d`。首次部署前请确认服务端 Docker Compose 可用，并确保服务端与构建机使用兼容的 CPU 架构。

用于正式部署的 `.env` 应设置 `NODE_ENV=production` 并配置可用的 SMTP；`.env.example` 中的 `development` 会通过 Compose 的 `env_file` 覆盖镜像内的生产环境设置。

镜像通过入口脚本初始化 `/app/data` 和 `/app/uploads` 的权限，然后以 `node` 用户运行。两个目录必须同时持久化。

## SHA-256 存储模型

`files.sha256` 是文件内容的唯一身份，同时用于数据库去重、API 文件指纹、磁盘路径和完整性校验。物理路径为：

```text
uploads/<sha256前2位>/<sha256第3-4位>/<完整sha256>
```

上传时先完整写入并同步物理文件，再提交数据库事务；永久删除或回收站记录到期后，才会回收没有引用的物理文件。异常中断最多留下可检测、可清理的孤儿文件，不会提交指向未落盘内容的新记录。

## 回收站

删除文件或文件夹会移入当前用户的回收站，默认保留 7 天，可通过 `TRASH_RETENTION_DAYS` 配置。每个用户的回收记录独立到期：用户 A 的记录到期不会影响仍由用户 B 使用的同一物理内容。物理文件仅在没有活跃引用、也没有任何未过期回收站引用后删除。删除会立即撤销关联访问链接；恢复后文件重新按正常权限访问。

浏览器在 Web Crypto 可用时计算 SHA-256 并尝试秒传；在不支持的环境或摘要计算失败时直接正常上传，由服务端计算 SHA-256 并去重。秒传只允许复用当前账号已经持有的内容，摘要不是访问凭证。

选择 SHA-256 而不是 MD5，是因为内容寻址系统必须避免可构造碰撞导致不同内容被误判为同一文件。代价是摘要和索引由 32 个十六进制字符增加到 64 个，浏览器整块摘要还会占用与文件大小相关的内存。

## 用户 API

健康检查、注册状态、邮箱验证码、注册、登录和密码重置接口无需登录；其他用户接口使用 `Authorization: Bearer <login-jwt>`。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/healthz` | 健康检查 |
| GET | `/auth/register-status` | 查询是否开放注册 |
| POST | `/auth/email-codes` | 发送注册或重置密码验证码 |
| POST | `/auth/register` | 注册 |
| POST | `/auth/login` | 登录 |
| POST | `/auth/password/reset` | 重置密码 |
| POST | `/auth/password/change` | 修改密码 |
| GET | `/drive` | 目录列表，支持 `folderId`、`name`、`limit`、`offset` |
| GET | `/drive/search` | 全局或当前目录搜索 |
| GET | `/drive/trash` | 查看回收站 |
| POST | `/drive/trash/:batchId/restore` | 恢复回收站项目 |
| DELETE | `/drive/trash/:batchId` | 永久删除回收站项目 |
| DELETE | `/drive/trash` | 清空回收站 |
| POST | `/drive/folder` | 创建文件夹 |
| PUT | `/drive/folder/:id` | 重命名文件夹 |
| DELETE | `/drive/folder/:id` | 将文件夹及内容移入回收站 |
| PUT | `/drive/file/:id` | 重命名文件 |
| DELETE | `/drive/file/:id` | 删除文件引用 |
| POST | `/drive/move` | 移动文件或文件夹 |
| POST | `/files/upload` | multipart 批量上传，字段名 `files` |
| POST | `/files/instant` | 按 SHA-256 尝试当前账号内秒传 |
| POST | `/files/:sha256/download-ticket` | 为浏览器原生下载签发 5 分钟有效的 HttpOnly 下载 Cookie |
| GET | `/files/:sha256/download` | 使用登录 JWT 或下载 Cookie 下载文件，支持 HTTP Range |
| GET | `/files/:sha256/thumbnail` | 获取图片缩略图 |

浏览器原生下载先携带登录 JWT 调用 `POST /files/:sha256/download-ticket`，服务端会设置仅适用于该文件下载路径、有效期 5 分钟的 HttpOnly Cookie，并返回 `path`；随后直接访问返回的路径即可下载，文件内容不会先进入页面内存。已有的 Bearer JWT 下载方式仍可使用。

秒传请求示例：

```json
{
  "folderId": null,
  "files": [
    {
      "sha256": "64位小写十六进制摘要",
      "originalName": "example.pdf"
    }
  ]
}
```

## 接入应用 API

登录用户可通过 `/integrations` 及其 Token 子路由管理接入应用。外部系统调用应用 API 时只接受：

```http
N-File-Token: <api-token>
```

| 方法 | 路径 | 权限 |
|------|------|------|
| GET | `/api/v1/files` | `files:read` |
| POST | `/api/v1/folders` | `files:upload` |
| POST | `/api/v1/files/upload` | `files:upload` |
| POST | `/api/v1/files/:id/access-links` | `links:create` |
| DELETE | `/api/v1/files/:id` | `files:delete` |
| GET | `/api/v1/trash` | `files:read` |
| POST | `/api/v1/trash/:batchId/restore` | `files:upload` |
| DELETE | `/api/v1/trash/:batchId` | `files:delete` |
| DELETE | `/api/v1/trash` | `files:delete` |

`GET /api/v1/files` 支持 `folderId`、`limit`、`offset`。默认每类返回 `DRIVE_PAGE_SIZE` 项（模板为 200），`limit` 最大 500；响应的 `folders` 和 `files` 分别按相同的 `offset` 分页，并通过 `page.hasMore` 表示是否还有下一页。

应用 Token 只能访问绑定根目录及其子目录。访问链接只通过以下路径公开读取：

```text
/n_file_system_api/access/:token
```

## 备份和校验

停止应用后同时备份 `data/` 和 `uploads/`。运行中只复制 `app.db` 可能遗漏 WAL 数据，也不能保证数据库与物理文件处于同一时间点。

```bash
npm run storage:check
npm run storage:check -- --quick
npm run storage:check -- --clean-orphans
```

完整检查验证 SQLite、逻辑引用、文件大小、SHA-256 和孤儿文件。执行 `--clean-orphans` 前应停止应用并完成备份。

## 开发验证

```bash
npm run check
npm test
npm audit --omit=dev
docker compose config
```

集成测试使用临时数据库和上传目录，不会修改实际运行数据。

## License

MIT
