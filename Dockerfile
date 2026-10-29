FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server ./server
COPY selfhost ./selfhost
ENV NODE_ENV=production BIND_HOST=0.0.0.0 PORT=3000 DATA_DIR=/tmp/little-family-care DATABASE_DRIVER=mysql DATABASE_LAYOUT=relational REMINDER_ENABLED=false
USER node
EXPOSE 3000
CMD ["node", "selfhost/main.cjs"]
