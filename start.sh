#!/bin/bash

# Create directories if they don't exist
mkdir -p data config

# Copy example config if no config exists
if [ ! -f config/tools.yaml ]; then
  cp examples/tools.yaml config/
  echo "Created config/tools.yaml from example"
fi

# Copy .env.example if no .env exists
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from example. Please edit with your values."
fi

# Install dependencies
npm install

# Start in dev mode
npm run dev