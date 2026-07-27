# Relay image (deployment.md D1): its own container — it is a wire,
# not application logic. Build from emulator/relay/:  docker build .

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

EXPOSE 8081
CMD ["node", "dist/main.js"]
