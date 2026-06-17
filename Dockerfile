# USM engine host (Railway etc.). Node 24 runs the TypeScript directly (no build step).
# Proprietary runtime data (cartridge, model.json, database.xml) is NOT baked in — the server
# fetches engine-data.zip from the Supabase 'proprietary' bucket at boot (see bootstrap.ts).
FROM node:24-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
ENV USM_DATA=/app/data
# PORT is provided by Railway; the server reads process.env.PORT.
CMD ["node", "src/engine/server.ts"]
