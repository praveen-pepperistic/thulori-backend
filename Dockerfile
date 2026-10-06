# Thulori API + worker image. Same image runs both:  CMD ["node","dist/server.js"]  or  ["node","dist/worker.js"]
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
RUN mkdir -p /data/uploads && chown node /data/uploads
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
