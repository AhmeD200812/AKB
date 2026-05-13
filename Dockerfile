FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000

COPY package.json ./
COPY backend ./backend
COPY frontend ./frontend
COPY database ./database

EXPOSE 4000

CMD ["npm", "start"]
