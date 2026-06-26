FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3040

COPY package.json ./
COPY backend ./backend
COPY frontend ./frontend
COPY database ./database

EXPOSE 3040

CMD ["npm", "start"]
