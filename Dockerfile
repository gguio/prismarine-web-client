# ---- Build Stage ----
FROM node:18-alpine AS build
# Without git installing the npm packages fails
RUN apk add --no-cache git python3 make g++ cairo-dev pango-dev jpeg-dev giflib-dev librsvg-dev
WORKDIR /app
COPY . /app
# install pnpm
RUN npm i -g pnpm@9.0.4
RUN pnpm install

# TODO for development
# EXPOSE 9090
# VOLUME /app/src
# VOLUME /app/prismarine-viewer
# ENTRYPOINT ["pnpm", "run", "run-all"]

# only for prod
RUN pnpm run build

# ---- Run Stage ----
FROM node:18-alpine
RUN apk add git
WORKDIR /app
# Copy build artifacts from the build stage
COPY --from=build /app/dist /app/dist
COPY server.js /app/server.js
# Install express
RUN npm i -g pnpm@9.0.4
RUN npm init -yp
RUN pnpm i express github:zardoy/prismarinejs-net-browserify compression cors
EXPOSE 8080
ENTRYPOINT ["node", "server.js"]
