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

服务默认监听 `http://localhost:3000`

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | `3000` |
| `JWT_SECRET` | JWT 签名密钥（**生产环境必须修改**） | 无（必填） |
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
      - "3000:3000"
    environment:
      JWT_SECRET: ${JWT_SECRET:-change-me-in-production}
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

### 请求示例

**登录：**

```bash
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"name": "alice", "password": "123456"}'
```

**上传文件：**

```bash
curl -X POST http://localhost:3000/files/upload \
  -H "Authorization: Bearer <token>" \
  -F "files=@/path/to/file.pdf" \
  -F "folderId="
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
