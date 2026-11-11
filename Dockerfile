FROM node:18-slim

WORKDIR /app

# Pehle package files copy karo
COPY package.json package-lock.json* ./

# Agar lockfile na ho toh clean install chalaye
RUN npm install --production || npm install

# Baaki saara code copy karo
COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
