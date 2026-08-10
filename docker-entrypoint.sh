#!/bin/sh
set -eu

# 兼容旧版本以 root 创建的持久化目录，随后降权运行服务。
mkdir -p /app/data /app/uploads/tmp

# 显式指定非 root 用户运行容器时不再尝试修改宿主机目录所有权。
if [ "$(id -u)" != "0" ]; then
  exec "$@"
fi

chown -R node:node /app/data

node_uid="$(id -u node)"
upload_uid="$(stat -c '%u' /app/uploads)"
temp_uid="$(stat -c '%u' /app/uploads/tmp)"
if [ "$upload_uid" != "$node_uid" ] || [ "$temp_uid" != "$node_uid" ]; then
  chown -R node:node /app/uploads
fi

exec su-exec node "$@"
