# syntax=docker/dockerfile:1

FROM node:22-alpine AS source
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

FROM source AS build-web
ARG VITE_DOCUMENT_API_BASE=http://localhost:3001
ENV VITE_DOCUMENT_API_BASE=${VITE_DOCUMENT_API_BASE}
RUN npm run build

FROM source AS api
ENV NODE_ENV=production
EXPOSE 3001
CMD ["npm", "run", "server"]

FROM build-web AS web
ENV NODE_ENV=production
EXPOSE 4173
CMD ["npm", "run", "preview", "--", "--host", "0.0.0.0", "--port", "4173"]
