# Guira Backend API

REST API de la plataforma financiera Guira. Construida con NestJS y Supabase, soporta transferencias interbancarias, wallets multi-moneda, cumplimiento KYC/KYB e integracion con Bridge para pagos internacionales.

## Tecnologias principales

- **Runtime:** Node.js >= 22.0.0
- **Framework:** NestJS 11
- **Base de datos / Auth:** Supabase (PostgreSQL + Auth)
- **Pagos internacionales:** Bridge API
- **Documentacion:** Swagger / OpenAPI
- **Contenedores:** Docker + Docker Compose

## Requisitos previos

- Node.js >= 22.0.0
- npm >= 10
- Cuenta en [Supabase](https://supabase.com)
- Credenciales de [Bridge API](https://bridge.xyz) (sandbox o produccion)

## Instalacion

```bash
git clone git@github.com:MAIKIREX/backend_Guira_oficial.git
cd backend_Guira_oficial

npm install

cp .env.example .env
```

Editar `.env` con las credenciales correspondientes (ver seccion de Variables de entorno).

## Ejecucion

```bash
# Desarrollo con hot reload
npm run start:dev

# Produccion
npm run build
npm run start:prod

# Debug
npm run start:debug
```

La API queda disponible en `http://localhost:3001/api` por defecto.
La documentacion Swagger se expone en `http://localhost:3001/api/docs` (solo en entornos no productivos).

## Docker

```bash
# Levantar contenedor de desarrollo
docker-compose up

# Reconstruir imagen
docker-compose up --build
```

El `docker-compose.yml` monta el codigo fuente con hot reload activado. Para produccion se usa un build multi-etapa que produce una imagen optimizada ejecutada como usuario no-root.

## Variables de entorno

| Variable | Descripcion | Ejemplo |
|---|---|---|
| `PORT` | Puerto del servidor | `3001` |
| `PATH_SUBDOMAIN` | Prefijo global de rutas | `api` |
| `URL_FRONTEND` | Origenes CORS permitidos (separados por coma) | `http://localhost:5173` |
| `SUPABASE_URL` | URL del proyecto Supabase | `https://xxx.supabase.co` |
| `SUPABASE_ANON_KEY` | Clave anonima de Supabase | `eyJ...` |
| `SUPABASE_SERVICE_ROLE_KEY` | Clave de servicio de Supabase (bypasa RLS) | `eyJ...` |
| `BRIDGE_API_URL` | URL base de Bridge API | `https://api.sandbox.bridge.xyz/v0` |
| `BRIDGE_API_KEY` | Clave de API de Bridge | `sk_test_...` |
| `BRIDGE_WEBHOOK_ID` | ID del webhook registrado en Bridge | `wep_...` |
| `BRIDGE_WEBHOOK_PUBLIC_KEY` | Clave publica RSA para verificar firmas | `-----BEGIN PUBLIC KEY-----...` |
| `BRIDGE_WEBHOOK_URL` | URL publica que recibe eventos de Bridge | `https://dominio.com/api/webhooks/bridge` |

## Arquitectura

```
src/
├── app.module.ts
├── main.ts
├── application/                  # Modulos de negocio
│   ├── auth/                     # Autenticacion y sesion
│   ├── profiles/                 # Perfiles de usuario
│   ├── onboarding/               # Flujo KYC/KYB
│   ├── wallets/                  # Wallets multi-moneda
│   ├── ledger/                   # Historial de transacciones
│   ├── payment-orders/           # Ordenes de pago (core)
│   ├── fees/                     # Comisiones
│   ├── exchange-rates/           # Tipos de cambio
│   ├── bridge/                   # Integracion Bridge API
│   ├── suppliers/                # Beneficiarios / proveedores
│   ├── client-bank-accounts/     # Cuentas bancarias de clientes
│   ├── compliance/               # KYC/KYB y documentos
│   ├── notifications/            # Email y SMS
│   ├── webhooks/                 # Eventos entrantes (Bridge)
│   ├── psav/                     # Cuentas PSAV (cripto)
│   ├── admin/                    # Panel de administracion
│   └── support/                  # Tickets de soporte
└── core/                         # Infraestructura transversal
    ├── config/                   # Validacion de env vars (Joi)
    ├── guards/                   # Auth, Roles, Rate limit
    ├── decorators/               # @CurrentUser, @Roles, @Public
    ├── supabase/                 # Cliente global Supabase
    ├── pdf/                      # Generacion de PDFs
    └── export/                   # Exportacion Excel
```

## Autenticacion y roles

Todas las rutas requieren un JWT de Supabase en el header `Authorization: Bearer <token>`, excepto las marcadas con el decorador `@Public()`.

El guard valida el token, carga el perfil del usuario y bloquea cuentas inactivas o congeladas.

| Rol | Descripcion |
|---|---|
| `client` | Usuario final de la plataforma |
| `staff` | Operador interno |
| `admin` | Administrador con acceso completo |
| `super_admin` | Superadministrador |

## Endpoints principales

### Auth — `/api/auth`

| Metodo | Ruta | Descripcion | Auth |
|---|---|---|---|
| POST | `/auth/register` | Registro de usuario | Publica |
| POST | `/auth/login` | Login con email y contrasena | Publica |
| GET | `/auth/me` | Perfil del usuario autenticado | JWT |
| POST | `/auth/refresh` | Renovar token de acceso | Publica |
| POST | `/auth/logout` | Cerrar sesion | JWT |
| POST | `/auth/forgot-password` | Solicitar reseteo de contrasena | Publica |
| POST | `/auth/reset-password` | Confirmar nuevo password | JWT |
| POST | `/auth/oauth-callback` | Callback de proveedor OAuth | Publica |

### Wallets — `/api/wallets`

| Metodo | Ruta | Descripcion |
|---|---|---|
| GET | `/wallets` | Listar wallets del usuario |
| GET | `/wallets/balances` | Saldos en todas las monedas |
| GET | `/wallets/balances/:currency` | Saldo de una moneda especifica |
| GET | `/wallets/payin-routes` | Cuentas virtuales para deposito |

### Ordenes de pago — `/api/payment-orders`

| Metodo | Ruta | Descripcion |
|---|---|---|
| POST | `/payment-orders/interbank` | Crear transferencia interbancaraio |
| POST | `/payment-orders/wallet-ramp` | On-ramp / off-ramp via Bridge |
| GET | `/payment-orders` | Listar ordenes del usuario |
| GET | `/payment-orders/:id` | Detalle de una orden |
| GET | `/payment-orders/:id/pdf` | Generar comprobante PDF |
| POST | `/payment-orders/:id/confirm-deposit` | Confirmar deposito con comprobante |
| POST | `/payment-orders/:id/cancel` | Cancelar orden pendiente |
| GET | `/payment-orders/exchange-rates` | Tipos de cambio vigentes |
| GET | `/payment-orders/export` | Exportar historial (Excel/PDF) |
| GET | `/payment-orders/limits/:flow_type` | Limites min/max por flujo |

### Admin — `/api/admin`

| Metodo | Ruta | Descripcion |
|---|---|---|
| GET | `/admin/payment-orders` | Listar todas las ordenes |
| GET | `/admin/payment-orders/stats` | Estadisticas del dashboard |
| POST | `/admin/payment-orders/:id/approve` | Aprobar orden |
| POST | `/admin/payment-orders/:id/complete` | Completar orden |
| POST | `/admin/payment-orders/:id/fail` | Marcar orden como fallida |
| POST | `/admin/wallets/balances/adjust` | Ajuste manual de saldo |
| POST | `/admin/wallets/initialize/:userId` | Reinicializar wallets post-KYC |

## Seguridad

- Rate limiting global: 100 peticiones / 60 segundos por IP
- Headers de seguridad con Helmet
- Validacion de firma RSA-SHA256 en webhooks de Bridge
- Validacion estricta de DTOs con `class-validator` (whitelist)
- Contenedor Docker ejecutado como usuario no-root

## Tests

```bash
# Unitarios
npm test

# Watch mode
npm run test:watch

# Cobertura
npm run test:cov

# End-to-end
npm run test:e2e
```

## Scripts disponibles

| Script | Descripcion |
|---|---|
| `npm run build` | Compilar TypeScript |
| `npm run start:dev` | Desarrollo con hot reload |
| `npm run start:prod` | Iniciar servidor de produccion |
| `npm run lint` | Corregir errores de linting |
| `npm run format` | Formatear codigo con Prettier |
