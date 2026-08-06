FROM node:24-alpine

WORKDIR /app

# 先复制依赖描述文件，利用 Docker 缓存层
COPY package.json package-lock.json ./

RUN npm ci --omit=dev

# 复制源码和前端静态文件
COPY src/ ./src/
COPY public/ ./public/
COPY scripts/ ./scripts/
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# 创建运行时目录
RUN apk add --no-cache su-exec \
    && mkdir -p data uploads/tmp \
    && chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/app.js"]
