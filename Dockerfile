FROM node:18-alpine

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies
RUN npm install --production && npm cache clean --force

# Copy application files
COPY . .

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodeuser -u 1001

# Change ownership of app directory
RUN chown -R nodeuser:nodejs /app

# Switch to non-root user
USER nodeuser

# Expose port 2021
EXPOSE 2021

# Start the application
CMD ["npm", "start"]