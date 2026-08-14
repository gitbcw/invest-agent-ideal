FROM node:22-bookworm-slim

WORKDIR /app

ENV PORTAL_PORT=3100
ENV PORTAL_RELAY_PORT=3199

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN PORTAL_DEV=1 npm run build

EXPOSE 3100 3199

CMD ["npm", "run", "start"]
