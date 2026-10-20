import { z } from 'zod';

const Environment = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.url(),
  ADMIN_TOKEN: z.string().min(32),
  WEBHOOK_SECRET: z.string().min(32),
  TENANT_ID: z.uuid(),
  EVOLUTION_URL: z.url(),
  EVOLUTION_API_KEY: z.string().min(1),
  EVOLUTION_INSTANCE: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(8090),
  HOST: z.string().default('0.0.0.0'),
  MEDIA_ROOT: z.string().default('./data/media')
});

export type Config = z.infer<typeof Environment>;
export const loadConfig = (): Config => Environment.parse(process.env);
export const JEV_PROVIDER = 'openrouter' as const;
export const JEV_MODEL = 'typesafe/jev-1.14' as const;
export const defaultSettings = {
  segments: ['automation_sales', 'barber_courses'],
  review: { mode: 'manual', confidenceThreshold: 0.95, allowedAutoLabels: [] as string[] },
  analysis: { provider: JEV_PROVIDER, model: JEV_MODEL, enabled: true },
  audio: { provider: 'unconfigured', model: '', language: 'pt' },
  documents: { provider: 'local', model: '', maxBytes: 20 * 1024 * 1024 },
  debounceSeconds: 20,
  maxWaitSeconds: 60,
  retentionDays: null as number | null
};

export const SettingsSchema = z.object({
  segments: z.array(z.enum(['automation_sales', 'barber_courses'])).min(1),
  review: z.object({
    mode: z.enum(['manual', 'assisted', 'automatic']),
    confidenceThreshold: z.number().min(0).max(1),
    allowedAutoLabels: z.array(z.string().max(80)).max(30)
  }),
  analysis: z.object({ provider: z.literal(JEV_PROVIDER), model: z.literal(JEV_MODEL), enabled: z.boolean() }),
  audio: z.object({ provider: z.enum(['unconfigured', 'openai']), model: z.string().max(100), language: z.string().max(8) }),
  documents: z.object({ provider: z.literal('local'), model: z.string().max(100), maxBytes: z.number().int().min(1).max(20 * 1024 * 1024) }),
  debounceSeconds: z.number().int().min(1).max(60),
  maxWaitSeconds: z.number().int().min(1).max(120),
  retentionDays: z.number().int().min(1).nullable()
}).strict();
export type Settings = z.infer<typeof SettingsSchema>;
