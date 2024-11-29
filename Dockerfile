FROM node:slim
WORKDIR /app
COPY . .
RUN apt update && \
    apt install dumb-init -y
RUN npm install && npm run build
ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "run", "start"]
