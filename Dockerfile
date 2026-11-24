# Calculadora de tributos (Simples Nacional + Regime Regular) — imagem para publicar a API.
# docker build -t calculadora-tributos .
# docker run -d -p 127.0.0.1:5180:5180 -e API_TOKEN="$(cat token-da-api.txt)" -e ALLOWED_HOSTS=calc.suaempresa.com.br -e TRUST_PROXY=1 calculadora-tributos
# (publicado só no 127.0.0.1 do host, atrás de um proxy reverso com HTTPS: veja o README, "Publicar a API")
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=5180
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY src ./src
COPY data ./data
COPY public ./public
COPY docs ./docs
USER node
EXPOSE 5180
# follows PORT when it is overridden (docker run -e PORT=...)
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5180)+'/api/saude').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
