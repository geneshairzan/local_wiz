FROM node:22-alpine
WORKDIR /app
COPY server/ ./server/
COPY public/ ./public/
ENV JARVIS_PORT=10000
EXPOSE 10000
CMD ["node", "server/index.js"]
