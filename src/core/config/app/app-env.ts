export const APP_ENV_VALUES = [
  'development',
  'test',
  'staging',
  'production',
] as const;

export type AppEnv = (typeof APP_ENV_VALUES)[number];

type Environment = Record<string, string | undefined>;

export const LOCAL_CORS_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:8081',
] as const;

/**
 * APP_ENV identifies Guira's functional deployment tier, while NODE_ENV
 * controls the Node/Nest runtime mode. Keeping them separate lets staging use
 * the production runtime without inheriting production-only UX behavior.
 */
export function resolveAppEnv(environment: Environment = process.env): AppEnv {
  return (environment.APP_ENV ??
    environment.NODE_ENV ??
    'development') as AppEnv;
}

export function isLocalAppEnv(appEnv: AppEnv): boolean {
  return appEnv === 'development' || appEnv === 'test';
}

export function isProtectedAppEnv(appEnv: AppEnv): boolean {
  return appEnv === 'staging' || appEnv === 'production';
}

export function isSwaggerEnabledAppEnv(appEnv: AppEnv): boolean {
  return appEnv === 'development' || appEnv === 'staging';
}

export function resolveCorsOrigins(appEnv: AppEnv, urlFrontend = ''): string[] {
  const configuredOrigins = urlFrontend
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter((origin) => origin.length > 0);

  if (!isLocalAppEnv(appEnv)) {
    return configuredOrigins;
  }

  return [...new Set([...configuredOrigins, ...LOCAL_CORS_ORIGINS])];
}

export function shouldRejectUnverifiedWebhook(appEnv: AppEnv): boolean {
  return isProtectedAppEnv(appEnv);
}
