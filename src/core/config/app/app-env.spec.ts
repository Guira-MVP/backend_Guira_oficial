import {
  isLocalAppEnv,
  isProtectedAppEnv,
  isSwaggerEnabledAppEnv,
  LOCAL_CORS_ORIGINS,
  resolveAppEnv,
  resolveCorsOrigins,
  shouldRejectUnverifiedWebhook,
} from './app-env';

describe('APP_ENV helpers', () => {
  it('uses NODE_ENV when APP_ENV is not defined', () => {
    expect(resolveAppEnv({ NODE_ENV: 'test' })).toBe('test');
  });

  it('uses APP_ENV over NODE_ENV for a Render staging runtime', () => {
    expect(resolveAppEnv({ NODE_ENV: 'production', APP_ENV: 'staging' })).toBe(
      'staging',
    );
  });

  it('defaults to development when neither variable is defined', () => {
    expect(resolveAppEnv({})).toBe('development');
  });

  it('classifies staging as protected with Swagger but without localhost CORS', () => {
    expect(isProtectedAppEnv('staging')).toBe(true);
    expect(isSwaggerEnabledAppEnv('staging')).toBe(true);
    expect(isLocalAppEnv('staging')).toBe(false);
    expect(isSwaggerEnabledAppEnv('production')).toBe(false);
  });

  it('allows the three local origins only in development and test', () => {
    expect(resolveCorsOrigins('development', 'https://app.guira.test')).toEqual(
      expect.arrayContaining(LOCAL_CORS_ORIGINS),
    );
    expect(resolveCorsOrigins('test')).toEqual([...LOCAL_CORS_ORIGINS]);
  });

  it('keeps staging CORS limited to URL_FRONTEND', () => {
    expect(
      resolveCorsOrigins('staging', 'https://staging.guira.test/'),
    ).toEqual(['https://staging.guira.test']);
  });

  it('rejects unverified webhooks in staging and production', () => {
    expect(shouldRejectUnverifiedWebhook('staging')).toBe(true);
    expect(shouldRejectUnverifiedWebhook('production')).toBe(true);
    expect(shouldRejectUnverifiedWebhook('development')).toBe(false);
    expect(shouldRejectUnverifiedWebhook('test')).toBe(false);
  });
});
