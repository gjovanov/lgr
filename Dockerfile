FROM oven/bun:canary-slim AS base

ENV HOST=0.0.0.0
ENV PORT=3001

COPY . /app
WORKDIR /app

RUN bun install && cd /app/packages/ui && bun run build

EXPOSE 3001/tcp

WORKDIR /app/packages/api
CMD ["bun", "run", "start"]
