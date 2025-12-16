FROM node:20-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Create directories for persistent data
RUN mkdir -p auth_info media

# Start the bot
CMD ["node", "index.js"]
