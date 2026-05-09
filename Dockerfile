FROM node:18-alpine

WORKDIR /app

# 先复制依赖描述文件，利用 Docker 缓存层
COPY package.json package-lock.json* ./

RUN npm install --production

# 复制源码
COPY src/ ./src/

# 创建运行时目录
RUN mkdir -p data uploads/tmp

EXPOSE 3000

CMD ["node", "src/app.js"]
