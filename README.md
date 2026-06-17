# nFileSystem

一个轻量级自托管文件管理系统，基于 Node.js 构建，支持多用户、文件夹层级管理、MD5 去重存储和秒传。

## 功能特性

- **用户系统**：注册/登录，JWT 鉴权，bcrypt 密码加密
- **文件夹管理**：无限层级嵌套，支持创建、重命名、移动、删除
- **文件管理**：上传、下载、重命名、移动、删除、在线预览
- **MD5 去重**：相同内容的文件只存储一份物理副本，节省磁盘空间
- **秒传**：客户端计算 MD5，已存在的文件无需重复上传
- **批量上传**：单次最多 20 个文件，单文件最大 50MB，带进度条
- **文件预览**：支持图片和文本类文件在线预览
- **接入应用**：支持为外部系统创建独立接入应用、API Token 和应用隔离目录
- **访问链接**：支持为文件生成无需登录的访问链接，可用于音频、歌词、封面、地图文件等外部访问场景
- **操作日志**：记录所有关键操作（登录、上传、删除等），含 IP 和 User-Agent
- **安全防护**：登录限流（同 IP 每分钟 10 次）、注册开关控制、文件访问权限隔离
- **Docker 部署**：开箱即用的容器化方案

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | Node.js + Express |
| 数据库 | SQLite3 |
| 文件上传 | Multer |
| 认证 | JWT + bcrypt |
| 前端 | 原生 HTML/CSS/JS |
| MD5 计算 | SparkMD5（前端）/ crypto（后端）|
| 容器化 | Docker + docker-compose |

## 项目结构

```
.
├── package.json              # 项目依赖与脚本
├── .env                      # 环境变量配置
├── Dockerfile                # Docker 镜像构建
├── docker-compose.yml        # Docker Compose 编排
├── public/                   # 前端静态资源
│   ├── index.html            # 主页面
│   ├── app.js                # 前端逻辑（认证、文件操作、上传等）
│   ├── style.css             # 样式
│   └── lib/
│       └── spark-md5.min.js  # 前端 MD5 计算库
├── src/                      # 后端源码
│   ├── app.js                # 入口文件（路由、中间件、启动）
│   ├── db.js                 # SQLite 初始化与数据库工具
│   ├── middleware/
│   │   └── auth.js           # JWT 鉴权中间件
│   └── utils/
│       └── security.js       # 密码哈希、JWT 签发/校验
├── data/                     # SQLite 数据库文件（运行后自动创建）
│   └── app.db
└── uploads/                  # 文件存储目录（运行后自动创建）
    ├── tmp/                  # Multer 临时目录
    └── xx/yy/md5.ext         # 按 MD5 分层存储
```

## 快速开始

### 本地开发

```bash
# 安装依赖
npm install

# 开发模式（热重载）
npm run dev

# 生产模式
npm start
```

服务默认监听 `http://localhost:6001`

### 环境变量

本地环境变量文件不应提交到源代码仓库。首次部署可复制模板：

```bash
cp .env.example .env
```

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | `6001` |
| `JWT_SECRET` | JWT 签名密钥，不配置服务会拒绝启动 | 无（必填） |
| `TOKEN_EXPIRES_IN` | Token 有效期 | 开发 `7d` / 生产 `2h` |
| `ALLOW_REGISTER` | 是否允许注册 | `false` |

## Docker 部署

### 构建镜像

```bash
docker build -t nfilesystem:latest .
```

### 使用 docker-compose 启动

```bash
docker compose up -d
```

`docker-compose.yml` 配置：

```yaml
services:
  nfilesystem:
    image: nfilesystem:latest
    container_name: nfilesystem
    restart: unless-stopped
    ports:
      - "6001:3000"
    environment:
      JWT_SECRET: ${JWT_SECRET:?JWT_SECRET is required}
      TOKEN_EXPIRES_IN: ${TOKEN_EXPIRES_IN:-30d}
      ALLOW_REGISTER: ${ALLOW_REGISTER:-false}
    volumes:
      - ./data:/app/data
      - ./uploads:/app/uploads
```

### 离线部署（无网络环境）

```bash
# 导出镜像
docker save -o nfilesystem.tar nfilesystem:latest

# 在目标服务器加载镜像
docker load -i nfilesystem.tar

# 启动
docker compose up -d
```

## API 接口

### 认证接口

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| GET | `/auth/register-status` | 查询是否允许注册 | 否 |
| POST | `/auth/register` | 用户注册 | 否 |
| POST | `/auth/login` | 用户登录，返回 JWT | 否 |

### 文件驱动接口（需鉴权）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/drive` | 获取当前目录内容（文件夹+文件），支持 `folderId` 和 `name` 查询参数 |
| POST | `/drive/folder` | 创建文件夹 |
| PUT | `/drive/folder/:id` | 重命名文件夹 |
| DELETE | `/drive/folder/:id` | 删除文件夹（递归） |
| PUT | `/drive/file/:id` | 重命名文件 |
| DELETE | `/drive/file/:id` | 删除文件引用（不删物理文件） |
| POST | `/drive/move` | 移动文件或文件夹 |

### 文件操作接口（需鉴权）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/files/upload` | 批量上传文件（字段名 `files`） |
| POST | `/files/instant` | 秒传（通过 MD5 匹配已有文件） |
| GET | `/files/:md5/download` | 按 MD5 下载文件 |

> 所有需鉴权接口需在请求头携带 `Authorization: Bearer <token>`

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
Authorization: Bearer <api-token>
```

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
  -H "Authorization: Bearer <api-token>" \
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

## 数据库设计

### users（用户表）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键 |
| name | TEXT | 用户名（唯一） |
| password | TEXT | bcrypt 哈希 |
| created_at | TEXT | 注册时间 |

### files（物理文件表，MD5 去重）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键 |
| stored_name | TEXT | 存储文件名（md5+扩展名） |
| md5 | TEXT | 文件内容 MD5（唯一） |
| size | INTEGER | 文件大小（字节） |
| mime_type | TEXT | MIME 类型 |
| created_at | TEXT | 入库时间 |

### user_folders（用户文件夹表）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键 |
| user_id | INTEGER | 所属用户 |
| parent_id | INTEGER | 父文件夹 ID（null=根目录） |
| name | TEXT | 文件夹名称 |
| created_at | TEXT | 创建时间 |

### user_files（用户文件引用表）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键 |
| user_id | INTEGER | 所属用户 |
| folder_id | INTEGER | 所在文件夹（null=根目录） |
| file_id | INTEGER | 关联 files 表 |
| name | TEXT | 用户自定义文件名 |
| created_at | TEXT | 创建时间 |

### logs（操作日志表）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键 |
| user_id | INTEGER | 操作用户 |
| action | TEXT | 操作类型 |
| target_type | TEXT | 目标类型（user/file/folder） |
| target_id | INTEGER | 目标 ID |
| detail | TEXT | 额外信息（JSON） |
| ip | TEXT | 客户端 IP |
| user_agent | TEXT | 浏览器 UA |
| created_at | TEXT | 记录时间 |

### integrations（接入应用表）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键 |
| user_id | INTEGER | 所属用户 |
| name | TEXT | 接入应用名称 |
| root_folder_id | INTEGER | 应用隔离根目录 |
| scopes | TEXT | 应用允许的权限，逗号分隔 |
| enabled | INTEGER | 是否启用 |
| created_at | TEXT | 创建时间 |

### api_tokens（API Token 表）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键 |
| integration_id | INTEGER | 所属接入应用 |
| user_id | INTEGER | 所属用户 |
| name | TEXT | Token 名称，同一应用下唯一 |
| token_hash | TEXT | API Token 的 SHA-256 哈希 |
| scopes | TEXT | Token 权限，必须是应用权限的子集 |
| expires_at | TEXT | 过期时间 |
| revoked_at | TEXT | 撤销时间（兼容历史数据） |
| last_used_at | TEXT | 最后使用时间 |
| created_at | TEXT | 创建时间 |

> API Token 明文只在创建时返回一次，数据库只保存哈希。

### access_links（访问链接表）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键 |
| user_id | INTEGER | 所属用户 |
| integration_id | INTEGER | 创建链接的接入应用 |
| user_file_id | INTEGER | 关联的用户文件引用 |
| token_hash | TEXT | 访问链接 token 的 SHA-256 哈希 |
| disposition | TEXT | `inline` 或 `download` |
| expires_at | TEXT | 过期时间 |
| max_uses | INTEGER | 最大访问次数 |
| use_count | INTEGER | 已访问次数 |
| revoked_at | TEXT | 撤销时间 |
| created_at | TEXT | 创建时间 |

## 存储规则

文件按 MD5 值分层存储，避免单目录文件过多：

```
MD5: a1b2c3d4e5f6...
扩展名: .pdf

存储路径: uploads/a1/b2/a1b2c3d4e5f6....pdf
           ↑一级目录  ↑二级目录  ↑完整MD5+扩展名
         (MD5前2位) (MD5第3-4位)
```

## License

MIT
