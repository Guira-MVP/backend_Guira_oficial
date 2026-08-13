import { environmentValidationSchema } from './environment.validation';

const requiredSupabase = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
};

const requiredStagingServices = {
  URL_FRONTEND: 'https://staging.guira.example',
  BRIDGE_API_KEY: 'sk_test_example',
  ZEPTOMAIL_TOKEN: 'Zoho-enczapikey example',
  EMAIL_FROM_ADDRESS: 'noreply@example.com',
};

describe('environmentValidationSchema', () => {
  it('allows staging without Sentry or a webhook public key', () => {
    const { error } = environmentValidationSchema.validate({
      NODE_ENV: 'production',
      APP_ENV: 'staging',
      SENTRY_DSN: '',
      BRIDGE_WEBHOOK_PUBLIC_KEY: '',
      ...requiredSupabase,
      ...requiredStagingServices,
    });

    expect(error).toBeUndefined();
  });

  it('requires Sentry in production', () => {
    const { error } = environmentValidationSchema.validate({
      NODE_ENV: 'production',
      APP_ENV: 'production',
      ...requiredSupabase,
      ...requiredStagingServices,
      BRIDGE_WEBHOOK_PUBLIC_KEY: 'public-key',
    });

    expect(error?.message).toContain('SENTRY_DSN');
  });

  it('rejects an unsupported APP_ENV', () => {
    const { error } = environmentValidationSchema.validate({
      NODE_ENV: 'production',
      APP_ENV: 'preview',
      ...requiredSupabase,
      ...requiredStagingServices,
    });

    expect(error?.message).toContain('APP_ENV');
  });

  it('requires URL_FRONTEND in staging and production', () => {
    const { error } = environmentValidationSchema.validate({
      NODE_ENV: 'production',
      APP_ENV: 'staging',
      ...requiredSupabase,
      BRIDGE_API_KEY: requiredStagingServices.BRIDGE_API_KEY,
      ZEPTOMAIL_TOKEN: requiredStagingServices.ZEPTOMAIL_TOKEN,
      EMAIL_FROM_ADDRESS: requiredStagingServices.EMAIL_FROM_ADDRESS,
    });

    expect(error?.message).toContain('URL_FRONTEND');
  });
});
