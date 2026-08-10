
# nFileSystem

轻量级自托管文件管理系统，基于 Node.js、Express 和 SQLite，面向单机、单实例部署。

## 主要能力

- 用户注册、登录、JWT 鉴权和 bcrypt 密码哈希
- 文件夹创建、重命名、移动、递归删除和层级防环
- 文件上传、下载、预览、重命名、移动和删除
- 新文件按 SHA-256 内容寻址，同一内容只保留一份物理副本
- 保留 MD5 下载 URL 和客户端秒传协议，旧 MD5 文件原地兼容
- SQLite WAL、完整同步、串行写队列和 `BEGIN IMMEDIATE` 事务
- 用户权限隔离、配额、磁盘低水位、上传并发限制和认证限流
- 目录分页、操作日志、健康检查和优雅关闭
- 接入应用、独立 API Token、目录隔离和可控访问链接
- SQLite、文件摘要、逻辑引用及孤儿文件校验工具

## 运行边界

当前版本只支持一个应用实例访问同一组 `data/` 和 `uploads/`。进程内数据库队列和存储锁保证单实例操作顺序，但不提供跨进程分布式锁。不要让多个容器或 Node.js 进程共享同一个 SQLite 数据库和上传目录。

持久化目录应放在可靠的本地块存储或本机文件系统上。不要直接放在不保证 SQLite 文件锁、原子重命名和目录 `fsync` 语义的 NFS、SMB 或对象存储挂载上。

## 环境要求

- Node.js 22 或更高版本，推荐 Node.js 24 LTS
- 支持 SQLite WAL 和常规 POSIX 文件操作的本地文件系统
- Docker 部署时使用 Docker Compose v2

## 快速开始

```bash
npm ci
cp .env.example .env
```

生成至少 32 字节的随机 JWT 密钥，并写入 `.env`：

```bash
openssl rand -hex 32
```

然后启动服务：

```bash
npm start
```

服务默认监听 `http://localhost:6001`。开发模式可使用 `npm run dev`，所有配置统一参考 `.env.example`。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 本地 HTTP 端口；Docker 中作为宿主机映射端口 | `6001` |
| `JWT_SECRET` | JWT 签名密钥，至少 32 字节 | 必填 |
| `TOKEN_EXPIRES_IN` | Token 有效期 | `.env.example` 为 `7d` |
| `ALLOW_REGISTER` | 是否开放注册 | `false` |
| `TRUST_PROXY` | 可信反向代理层数或 Express 预设值 | `false` |
| `DATA_DIR` | SQLite 数据目录 | `./data` |
| `UPLOAD_DIR` | 物理文件目录 | `./uploads` |
| `SQLITE_BUSY_TIMEOUT_MS` | SQLite 锁等待时间 | `5000` |
| `MAX_UPLOAD_FILES` | 单次上传文件数 | `20` |
| `MAX_FILE_SIZE_BYTES` | 单文件大小上限 | `52428800` |
| `MAX_UPLOAD_BYTES` | 单次上传总大小上限 | `MAX_UPLOAD_FILES * MAX_FILE_SIZE_BYTES` |
| `MAX_UPLOAD_CONCURRENCY` | 同时处理的上传请求数 | `2` |
| `USER_QUOTA_BYTES` | 每用户逻辑文件配额，`0` 表示不限制 | `10737418240` |
| `MIN_FREE_BYTES` | 上传后必须保留的磁盘空间 | `268435456` |
| `DRIVE_PAGE_SIZE` | 每类目录项的默认分页大小 | `200` |
| `MAX_FOLDER_DEPTH` | 最大文件夹深度 | `128` |
| `STALE_TEMP_MAX_AGE_MS` | 上传临时文件保留时长 | `86400000` |
| `AUTH_RATE_LIMIT` | 认证窗口内最大尝试次数 | `10` |
| `AUTH_RATE_WINDOW_MS` | 认证限流窗口 | `60000` |

`.env` 已被 Git 忽略，不应提交真实密钥。`.env.example` 只用于说明配置，不会被应用自动加载；本地运行和 Docker Compose 都使用项目根目录的 `.env`。

## Docker 部署

先创建配置，设置 `JWT_SECRET` 并将 `NODE_ENV` 调整为 `production`，再构建并启动：

```bash
cp .env.example .env
# 编辑 .env，填入随机 JWT_SECRET
docker compose up -d --build
```

查看健康状态：

```bash
docker compose ps
docker compose logs --tail 100 n-file-system
```

生产镜像需要 `docker-entrypoint.sh`。它在容器启动时兼容修正旧持久化卷权限，然后通过 `su-exec` 降权为 `node` 用户运行服务；Dockerfile 会强制清理 Windows CRLF 并设置可执行权限。`data/` 和 `uploads/` 必须同时持久化，只保留其中一个目录不能构成可恢复备份。

Compose 通过 `env_file` 将 `.env` 直接注入容器；`PORT` 同时用于容器监听端口和宿主机映射端口，无需在 `docker-compose.yml` 中重复维护变量。

如果容器启动后立即退出，优先执行 `docker compose logs --tail 100 n-file-system`。常见原因包括 `.env` 未填写至少 32 字节的 `JWT_SECRET`、旧镜像未使用 `--build` 重建，或宿主机持久化目录不可写。

## 从旧版本升级

升级会自动把旧数据库迁移到 schema v2。已有用户、目录、文件引用和下载 URL 保持不变；旧物理文件仍从 `uploads/<md5前2位>/<md5第3-4位>/<md5+扩展名>` 读取，不会在启动时批量搬迁。只有新上传内容使用 SHA-256 路径。

建议按以下顺序升级：

1. 停止旧服务，完整备份 `data/` 和 `uploads/`。
2. 升级到 Node.js 22+，执行 `npm ci`，或重新构建 Docker 镜像。
3. 检查 `.env`，保留自定义强密钥可避免现有登录失效。
4. 启动一次服务，让数据库迁移在事务中完成。
5. 停止服务并运行一次 `npm run storage:check`，确认数据和物理文件一致。

仓库旧版本曾提交过 `my-dev-secret-change-in-production`。该值已经泄露并被当前版本拒绝；如果部署仍在使用它，必须换成新的随机密钥，现有登录会失效一次。代码和数据库无法替你安全地轮换外部部署密钥。

## 备份与恢复

最稳妥的备份方式是停止应用后，同时复制 `data/` 和 `uploads/`。SQLite 使用 WAL，应用运行时只复制 `app.db` 可能遗漏尚未检查点的数据。必须在线备份时，应使用 SQLite 的在线备份 API 或 `.backup` 命令，并确保物理文件目录在同一备份时间点得到一致快照。

恢复前先停止应用，将数据库和上传目录恢复到同一份备份，再启动服务并执行存储校验。不要只回滚数据库或只回滚物理文件目录。

## 存储校验

完整校验会检查 SQLite、文件夹和文件引用、物理文件大小、MD5、SHA-256 以及孤儿文件：

```bash
npm run storage:check
```

跳过摘要计算、只做快速检查：

```bash
npm run storage:check -- --quick
```

清理数据库未引用的物理文件：

```bash
npm run storage:check -- --clean-orphans
```

普通检查可以在线执行，但结果可能包含正在提交的瞬时状态。运行 `--clean-orphans` 前必须停止应用并完成备份，避免与上传事务竞争。校验返回非零状态表示发现异常或未清理的孤儿文件。

## 一致性策略

上传时先把物理文件完整写入并同步，再提交数据库事务；删除时先提交引用删除，再回收物理文件。因此进程或主机在两个步骤之间异常退出时，最坏情况是留下可校验、可清理的孤儿文件，不会提交指向尚未落盘内容的新数据库记录。

新内容同时计算 MD5 和 SHA-256。MD5 只用于兼容现有 API 和客户端秒传；物理去重及内容寻址以 SHA-256 为准。若 MD5 相同但 SHA-256 不同，上传会被拒绝，不会静默覆盖已有内容。

秒传只允许复用当前账号已经持有的内容。其他用户即使知道某个 MD5，也不能借此取得文件引用；首次取得内容仍需正常上传文件字节。

## API

所有需鉴权接口使用请求头 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/healthz` | 数据库和存储目录健康检查 |
| GET | `/auth/register-status` | 查询是否开放注册 |
| POST | `/auth/register` | 注册 |
| POST | `/auth/login` | 登录并返回 JWT |
| GET | `/drive` | 获取目录项，支持 `folderId`、`name`、`limit`、`offset` |
| POST | `/drive/folder` | 创建文件夹 |
| PUT | `/drive/folder/:id` | 重命名文件夹 |
| DELETE | `/drive/folder/:id` | 递归删除文件夹及引用，回收最后引用的物理文件 |
| PUT | `/drive/file/:id` | 重命名文件 |
| DELETE | `/drive/file/:id` | 删除引用，必要时回收物理文件 |
| POST | `/drive/move` | 移动文件或文件夹 |
| POST | `/files/upload` | 批量上传，multipart 字段名为 `files` |
| POST | `/files/instant` | 按 MD5 尝试当前账号内秒传 |
| GET | `/files/:md5/download` | 按兼容 MD5 URL 下载 |

`GET /drive` 返回 `folders`、`files`、`breadcrumb` 和 `page`。文件夹和文件分别分页，`page.hasMore` 为 `true` 时继续增加 `offset`。


### 接入应用管理接口（需登录 JWT）

这些接口用于在前端“接入应用”管理页维护外部系统接入能力。登录用户可以为音乐 App、地图服务、文档系统等创建独立应用，每个应用绑定一个根目录和一组权限。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/integrations` | 获取当前用户的接入应用列表 |
| POST | `/integrations` | 创建接入应用，可自动创建默认 API Token |
| PUT | `/integrations/:id` | 启用或禁用接入应用 |
| GET | `/integrations/:id/tokens` | 获取应用下的 API Token 列表（不返回明文 token） |
| POST | `/integrations/:id/tokens` | 创建 API Token，明文 token 只返回一次 |
| PUT | `/integrations/:integrationId/tokens/:tokenId` | 编辑 API Token 名称和权限 |
| DELETE | `/integrations/:integrationId/tokens/:tokenId` | 删除 API Token |

API Token 权限：

| 权限 | 说明 |
|------|------|
| `files:upload` | 上传文件、创建文件夹 |
| `files:read` | 读取应用根目录内的文件和文件夹列表 |
| `files:delete` | 删除应用根目录内的文件引用 |
| `links:create` | 创建文件访问链接 |

### 应用接入 API（需 API Token）

这些接口给外部系统后端调用。API Token 只能访问所属接入应用绑定的根目录及其子目录，不能访问用户网盘中的其它目录。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/files` | 获取应用目录内容，支持 `folderId` 查询参数 |
| POST | `/api/v1/folders` | 在应用根目录或子目录下创建文件夹 |
| POST | `/api/v1/files/upload` | 上传文件到应用目录，字段名 `files` |
| POST | `/api/v1/files/:id/access-links` | 为指定文件创建访问链接 |
| DELETE | `/api/v1/files/:id` | 删除应用目录内的文件引用 |

应用 API 请求头：

```http
N-File-Token: <api-token>
```

为兼容旧接入方式，应用 API 也继续支持 `Authorization: Bearer <api-token>`。如果第三方系统已经使用自己的 `Authorization`，推荐使用 `N-File-Token`。

### 访问链接接口（无需登录）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/n_file_system_api/access/:token` | 通过访问链接读取文件，支持 inline 预览/播放或 download 下载 |
| GET | `/access/:token` | 旧版兼容入口，不建议新接入继续使用 |

### 请求示例

**登录：**

```bash
curl -X POST http://localhost:6001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"name": "alice", "password": "123456"}'
```

**上传文件：**

```bash
curl -X POST http://localhost:6001/files/upload \
  -H "Authorization: Bearer <token>" \
  -F "files=@/path/to/file.pdf" \
  -F "folderId="
```

**创建接入应用：**

```bash
curl -X POST http://localhost:6001/integrations \
  -H "Authorization: Bearer <login-jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "music-app",
    "rootFolderName": "music-app",
    "scopes": ["files:upload", "files:read", "links:create"],
    "createToken": true
  }'
```

返回的 `token.token` 是 API Token 明文，只显示一次，应保存在接入系统后端，不应放在前端页面或移动端安装包中。

**应用上传文件并直接创建访问链接：**

```bash
curl -X POST http://localhost:6001/api/v1/files/upload \
  -H "N-File-Token: <api-token>" \
  -F "files=@/path/to/song.mp3" \
  -F "withAccessLink=true" \
  -F "disposition=inline"
```

返回示例：

```json
{
  "message": "上传成功",
  "files": [
    {
      "id": 123,
      "name": "song.mp3",
      "md5": "e10adc3949ba59abbe56e057f20f883e",
      "accessLink": {
        "path": "/n_file_system_api/access/nfs_al_xxx",
        "expiresAt": null,
        "disposition": "inline"
      }
    }
  ]
}
```

`accessLink.path` 是相对路径，不绑定文件服务所在域名、主机或端口。`/n_file_system_api` 是文件服务对外访问前缀，接入方可以按自己的网关或反向代理规则拼接完整地址，例如：

```text
https://music.example.com + /n_file_system_api/access/nfs_al_xxx
```



## 存储布局

新文件使用无扩展名 SHA-256 内容地址：

```text
uploads/<sha256前2位>/<sha256第3-4位>/<完整sha256>
```

旧版本文件继续使用原 MD5 路径：

```text
uploads/<md5前2位>/<md5第3-4位>/<完整md5+原扩展名>
```

数据库的 `storage_key` 区分两类路径。不要直接重命名或移动 `uploads/` 内的文件。

## 开发与验证

```bash
npm run check
npm test
npm audit --omit=dev
```

集成测试使用临时数据库和临时上传目录，不会修改仓库中的实际数据。

## 项目结构

```text
.
├── public/                 # 前端静态资源
├── scripts/storage-check.js
├── src/app.js             # HTTP 路由和服务生命周期
├── src/db.js              # SQLite 队列、事务和迁移
├── src/storage.js         # 内容寻址、落盘和完整性校验
├── test/integration.test.js
├── Dockerfile
├── docker-compose.yml
├── package.json
└── package-lock.json
```

## License

MIT
