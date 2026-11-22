FROM node:20-bookworm-slim

# Cài đặt Python và pip để chạy yt-dlp
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Cài đặt yt-dlp bản mới nhất
RUN pip3 install --no-cache-dir --break-system-packages yt-dlp

WORKDIR /app

# Copy dependencies manifest
COPY server/package*.json ./server/

WORKDIR /app/server
RUN npm install --production

# Copy toàn bộ mã nguồn
WORKDIR /app
COPY . .

WORKDIR /app/server

EXPOSE 3000

ENV PORT=3000
ENV NODE_ENV=production

CMD ["node", "index.js"]
