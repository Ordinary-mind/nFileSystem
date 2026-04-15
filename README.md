# 文件管理系统（Node.js + Express + Multer + SQLite）

一个简洁的文件管理后端示例，支持：

- 用户注册、登录（JWT 鉴权）
- 未登录上传时返回 `401`
- 批量上传文件（`files` 字段）
- 按文件内容计算 MD5，并按规则落盘：
  - 一级目录：MD5 前 2 位
  - 二级目录：MD5 第 3~4 位
  - 文件名：`md5 + 原始扩展名`
- 记录上传前后文件名与存储路径到 SQLite
- 按文件 ID 下载（仅允许下载当前用户自己的文件）

---

## 1. 项目结构

```txt
.
├─ package.json
├─ README.md
├─ src
│  ├─ app.js                 # 入口与路由
│  ├─ db.js                  # SQLite 初始化与 DB 工具
│  ├─ middleware
│  │  └─ auth.js             # JWT 鉴权中间件
│  └─ utils
│     └─ security.js         # 密码摘要、JWT 签发/校验
├─ data
│  └─ app.db                 # SQLite 数据库（运行后自动创建）
└─ uploads
   ├─ tmp                    # Multer 临时目录
   └─ xx/yy/md5.ext          # 按 MD5 分层后的文件目录
```

---

## 2. 安装与启动

```bash
npm install
npm start
```

默认监听：`http://localhost:3000`

可选环境变量：

- `PORT`：服务端口（默认 `3000`）
- `JWT_SECRET`：JWT 密钥（强烈建议在生产环境设置）

---

## 3. 数据表说明

### users

- `id`：主键
- `name`：用户名（唯一）
- `password`：密码摘要（当前用 SHA256）
- `created_at`：创建时间

### files

- `id`：主键
- `user_id`：上传用户 ID
- `original_name`：原始文件名
- `stored_name`：落盘文件名（md5+扩展名）
- `relative_path`：相对路径（如 `ab/cd/xxxxxxxx.png`）
- `md5`：文件内容 MD5
- `size`：文件大小（字节）
- `mime_type`：MIME 类型
- `created_at`：上传时间

---

## 4. API 说明

## 4.1 注册

`POST /auth/register`

```json
{
  "name": "alice",
  "password": "123456"
}
```

## 4.2 登录

`POST /auth/login`

```json
{
  "name": "alice",
  "password": "123456"
}
```

返回示例：

```json
{
  "message": "登录成功",
  "token": "<JWT_TOKEN>",
  "user": { "id": 1, "name": "alice" }
}
```

## 4.3 批量上传（需要鉴权）

`POST /files/upload`

- Header: `Authorization: Bearer <JWT_TOKEN>`
- Body: `multipart/form-data`
- 文件字段：`files`（可多个）

未携带 token 或 token 无效时返回 `401`。

## 4.4 文件列表（需要鉴权）

`GET /files`

- Header: `Authorization: Bearer <JWT_TOKEN>`

## 4.5 文件下载（需要鉴权）

`GET /files/:id/download`

- Header: `Authorization: Bearer <JWT_TOKEN>`
- 仅可下载当前登录用户自己上传的文件

---

## 5. MD5 存储规则示例

若某文件内容 MD5 为：

`a1b2c3d4e5f6...`

且原文件扩展名是 `.pdf`，则：

- 一级目录：`a1`
- 二级目录：`b2`
- 最终文件名：`a1b2c3d4e5f6....pdf`
- 相对路径：`a1/b2/a1b2c3d4e5f6....pdf`

---

## 6. 安全提示（生产环境）

当前示例偏教学用途，生产请至少做以下增强：

1. 密码哈希改为 `bcrypt/argon2`
2. 设置强随机 `JWT_SECRET`
3. 增加上传文件类型白名单、病毒扫描、限流等
4. 增加日志审计与错误监控
