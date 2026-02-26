FROM node:22

RUN apt-get update && apt-get install -y tmux && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . .

RUN yarn

CMD ["sleep", "infinity"]
