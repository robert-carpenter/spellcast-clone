FROM node:18-alpine AS builder
WORKDIR /app

# Install frontend deps and build
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Install server deps and build TypeScript
WORKDIR /app/server
COPY server/package*.json ./
RUN npm install
RUN npm run build

FROM node:18-alpine AS runner
WORKDIR /app

# Copy built frontend bundle
COPY --from=builder /app/dist ./dist

# Copy server build output and install prod deps
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/server/package*.json ./server/
WORKDIR /app/server
RUN npm install --omit=dev

ENV NODE_ENV=production
ENV PORT=3000

CMD ["node", "dist/src/server.js"]
