FROM node:22-bookworm-slim

# Install system dependencies required for headless Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Install Playwright Chromium browser binary
RUN npx playwright install chromium

# Copy application source
COPY . .

# Ensure data directory exists
RUN mkdir -p /app/data

# Environment configuration defaults
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV FLIQ_RUN_SUITES_ON_START=false
ENV NODE_OPTIONS="--max-old-space-size=256"

EXPOSE 3000

# Run build script to generate static assets and config
RUN node scripts/build.mjs

CMD ["node", "server.js"]
