import { registerAs } from '@nestjs/config';

const toInt = (v: string | undefined, def: number) =>
  v !== undefined && v !== '' ? parseInt(v, 10) : def;

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production' | string;
  port: number;
  pathSubdomain: string;
  urlFrontend: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  bridgeApiKey: string;
  bridgeApiUrl: string;
  bridgeWebhookPublicKey: string;
}

export default registerAs(
  'app',
  (): AppConfig => ({
    nodeEnv: (process.env.NODE_ENV as AppConfig['nodeEnv']) ?? 'development',
    port: toInt(process.env.PORT, 3001),
    pathSubdomain: process.env.PATH_SUBDOMAIN ?? 'api',
    urlFrontend: process.env.URL_FRONTEND ?? '',
    supabaseUrl: process.env.SUPABASE_URL ?? '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? '',
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    bridgeApiKey: process.env.BRIDGE_API_KEY ?? '',
    bridgeApiUrl: process.env.BRIDGE_API_URL ?? '',
    bridgeWebhookPublicKey: process.env.BRIDGE_WEBHOOK_PUBLIC_KEY ?? '',
  }),
);
