FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
USER node
EXPOSE 3000
# Runs migrations, the API and the Planfix sync worker in one process.
CMD ["npx", "tsx", "src/index.ts"]
