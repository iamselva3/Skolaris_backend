
FROM node:20-slim AS build

WORKDIR /app

# Required for Prisma
RUN apt-get update && \
    apt-get install -y openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY prisma ./prisma

RUN npm ci

COPY . .

RUN npx prisma generate
RUN npm run build

# -------------------------
# Runtime Stage
# -------------------------
FROM node:20-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production

# Required for Prisma runtime
RUN apt-get update && \
    apt-get install -y openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma

EXPOSE 3000

CMD ["node", "dist/main.js"]