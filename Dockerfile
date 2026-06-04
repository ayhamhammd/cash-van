ARG NODE_VERSION=20.17-alpine3.20

FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

FROM node:${NODE_VERSION} AS dev
WORKDIR /app
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 3000 9229
CMD ["npm", "run", "start:dev"]

FROM node:${NODE_VERSION} AS build
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:${NODE_VERSION} AS production
WORKDIR /app
RUN addgroup -g 1001 -S nodegrp && adduser -S nodeusr -u 1001 -G nodegrp
USER nodeusr
ENV NODE_ENV=production
COPY --from=build --chown=nodeusr:nodegrp /app/dist ./dist
COPY --from=build --chown=nodeusr:nodegrp /app/node_modules ./node_modules
COPY --from=build --chown=nodeusr:nodegrp /app/package.json ./
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/api/v1/health || exit 1
CMD ["node", "dist/main.js"]
