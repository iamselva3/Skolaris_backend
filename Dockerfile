# --- build ---
FROM node:20-alpine AS build
WORKDIR /app

# OpenSSL must be present BEFORE `prisma generate` so Prisma detects OpenSSL 3.0
# and emits the linux-musl-openssl-3.0.x query engine (not the 1.1 fallback).
RUN apk add --no-cache openssl

COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

COPY . .
RUN npx prisma generate
RUN npm run build

# --- runtime ---
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Runtime needs the OpenSSL shared library the Prisma engine links against.
RUN apk add --no-cache openssl

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma

EXPOSE 3000
CMD ["node", "dist/main.js"]
