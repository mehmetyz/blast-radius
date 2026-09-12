FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY tsconfig.json ./
COPY src ./src
ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/data/blast-radius.db
EXPOSE 3000
CMD ["node", "--import", "tsx", "src/index.ts"]
