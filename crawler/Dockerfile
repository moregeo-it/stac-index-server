# Use official Node.js LTS image
FROM node:24-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy application files
COPY . .

# Default: scheduler with weekly full re-crawl cycles (resumes an unfinished cycle on restart).
# For a single one-off run use: docker compose run --rm crawler node index.js
CMD ["node", "scheduler.js"]
