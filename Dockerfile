# Use Node.js LTS (Slim for better compatibility with Python/Build tools)
FROM node:20-slim

WORKDIR /app

# Allow pip to install system-wide packages (PEP 668)
ENV PIP_BREAK_SYSTEM_PACKAGES=1

# Install system dependencies
# Python 3, pip, build tools for native modules (sqlite3, lancedb)
RUN apt-get update && apt-get install -y \
    sqlite3 \
    procps \
    curl \
    python3 \
    python3-pip \
    python3-venv \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Install HMC Python Dependencies first (layer caching)
COPY src/hmic/requirements.txt ./src/hmic/requirements.txt
RUN pip3 install -r src/hmic/requirements.txt
# Download spaCy model
RUN python3 -m spacy download en_core_web_lg

# Install Node Dependencies
COPY package*.json ./
RUN npm install

# Build App
COPY . .
RUN npm run build

# Expose Port
EXPOSE 3000

# Start Command
CMD ["npm", "start"]
