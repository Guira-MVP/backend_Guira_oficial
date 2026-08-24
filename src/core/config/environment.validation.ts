import * as Joi from 'joi';
import { APP_ENV_VALUES } from './app/app-env';

const deployedAppEnv = Joi.string().valid('staging', 'production');

export const environmentValidationSchema = Joi.object({
  // Runtime mode: Render staging and production both run as production.
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  // Functional tier: controls exposure and security behavior in the app.
  APP_ENV: Joi.string()
    .valid(...APP_ENV_VALUES)
    .required(),
  PORT: Joi.number().default(3000),
  PATH_SUBDOMAIN: Joi.string().default('api'),
  URL_FRONTEND: Joi.when('APP_ENV', {
    is: deployedAppEnv,
    then: Joi.string().uri().required(),
    otherwise: Joi.string().allow('').default(''),
  }),

  // Sentry is intentionally disabled in staging but mandatory in production.
  SENTRY_DSN: Joi.when('APP_ENV', {
    is: 'production',
    then: Joi.string().uri().required(),
    otherwise: Joi.string().allow('').default(''),
  }),

  // Supabase
  SUPABASE_URL: Joi.string().uri().required(),
  SUPABASE_ANON_KEY: Joi.string().required(),
  SUPABASE_SERVICE_ROLE_KEY: Joi.string().required(),

  // Bridge API must be configured for the two remotely deployed tiers.
  BRIDGE_API_KEY: Joi.when('APP_ENV', {
    is: deployedAppEnv,
    then: Joi.string().required(),
    otherwise: Joi.string().allow('').default(''),
  }),
  BRIDGE_API_URL: Joi.string()
    .uri()
    .allow('')
    .default('https://api.bridge.xyz'),
  // Staging can be deployed before its sandbox webhook is registered. Until
  // configured, invalid or unsigned events are rejected by the service.
  BRIDGE_WEBHOOK_PUBLIC_KEY: Joi.when('APP_ENV', {
    is: 'production',
    then: Joi.string().required(),
    otherwise: Joi.string().allow('').default(''),
  }),

  BINANCE_P2P_API_URL: Joi.string()
    .uri()
    .allow('')
    .default('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search'),

  // Transactional email is required in staging and production.
  ZEPTOMAIL_TOKEN: Joi.when('APP_ENV', {
    is: deployedAppEnv,
    then: Joi.string().required(),
    otherwise: Joi.string().allow('').default(''),
  }),
  ZEPTOMAIL_API_URL: Joi.string()
    .uri()
    .allow('')
    .default('https://api.zeptomail.com/v1.1/email'),
  EMAIL_FROM_ADDRESS: Joi.when('APP_ENV', {
    is: deployedAppEnv,
    then: Joi.string().email().required(),
    otherwise: Joi.string().allow('').default(''),
  }),
  EMAIL_FROM_NAME: Joi.string().allow('').default('Guira'),
});
