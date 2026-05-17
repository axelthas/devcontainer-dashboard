# Build stage
FROM node:22-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build && npm run build:server

# Run stage
FROM node:22-alpine

# git and openssh-client are available for operator hook scripts that clone repos
RUN apk add --no-cache git openssh-client

# devcontainer CLI is a product dependency required for "Build & Start" workspace actions
RUN npm install -g @devcontainers/cli

WORKDIR /app

COPY --from=builder /app/build ./build
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

EXPOSE 3000

CMD ["sh", "docker-entrypoint.sh"]
