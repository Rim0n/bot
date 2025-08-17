#!/bin/bash
# Termux startup script for Discord bot

echo "Starting Discord Bot on Termux..."

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

# Check if .env exists
if [ ! -f ".env" ]; then
    echo "Creating .env from template..."
    cp .env.example .env
    echo "Please edit .env with your tokens before running again!"
    exit 1
fi

# Start the bot
echo "Launching bot..."
node index.js
