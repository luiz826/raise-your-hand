# Raise Your Hand backend. Build: docker build -t ryh-backend .
# Run:   docker run -p 8787:8787 -e ANTHROPIC_API_KEY=sk-... -v ryh-data:/app/data ryh-backend
#
# Notes:
# - Pass ANTHROPIC_API_KEY (and optional RYH_* config) as env vars — never bake
#   .env into the image.
# - Mount a volume at /app/data so JIT-ingested course maps + telemetry persist.
# - Set RYH_ALLOWED_ORIGIN to the published extension origin (chrome-extension://<id>).
FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

ENV HOST=0.0.0.0
ENV PORT=8787
EXPOSE 8787

CMD ["npx", "tsx", "src/server.ts"]
