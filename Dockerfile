# Multi-stage build para optimizar la imagen final de producción
FROM node:22.16.0-alpine3.21 AS builder

# Crear directorio de app
WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar TODAS las dependencias (incluyendo devDependencies para compilar)
RUN npm ci

# Copiar el código fuente completo
COPY . .

# Compilar proyecto TypeScript a JavaScript
RUN npm run build

# ---
# STAGE 2: Imagen de Producción (distroless/alpine minimizado)
# ---
FROM node:22.16.0-alpine3.21 AS runner

WORKDIR /app

# Establecer entorno en producción
ENV NODE_ENV=production
ENV PORT=3000

# Solo copiar el manifiesto
COPY package*.json ./

# Instalar ÚNICAMENTE dependencias de producción 
# Esto reduce drásticamente el tamaño y la superficie de ataque
RUN npm ci --omit=dev

# Mover el build compilado desde la etapa builder
COPY --from=builder /app/dist ./dist

# Usuario no root por temas de seguridad
USER node

# Exponer el puerto
EXPOSE 3000

# Arrancar la aplicación
CMD ["node", "dist/main"]
