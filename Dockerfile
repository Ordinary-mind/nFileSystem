FROM node:24-alpine

WORKDIR /app

# 先复制依赖描述文件，利用 Docker 缓存层
COPY package.json package-lock.json ./

# sqlite3 是原生模块：预编译二进制不可用时会回退到源码编译，
# 而 Alpine 镜像默认不带工具链。这里安装临时构建依赖，编译后清理，
# 仅保留编译产物运行时需要的 libstdc++，避免镜像无谓变大。
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm_config_nodedir=/usr/local npm ci --omit=dev \
    && apk del .build-deps \
    && apk add --no-cache libstdc++

# 复制源码和前端静态文件
COPY src/ ./src/
COPY public/ ./public/
COPY scripts/ ./scripts/
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# 创建运行时目录
RUN apk add --no-cache su-exec \
    && mkdir -p data uploads/tmp \
    && sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
    && chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
# 端口默认值与 EXPOSE / HEALTHCHECK / docker-compose 的 6001 保持一致
ENV PORT=6001

EXPOSE 6001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||6001)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/app.js"]
