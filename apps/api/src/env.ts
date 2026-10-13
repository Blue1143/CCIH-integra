import { z } from 'zod';

/** Environment, validated at startup: a misconfigured server refuses to start instead of running unsafely. */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.string().url(),
  DATABASE_OWNER_URL: z.string().url().optional(),
  APP_ORIGIN: z.string().url(),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(480).default(30),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(24).default(12),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(20).default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  /** Login attempts per IP per minute (brute-force throttling, in addition to the per-account lock). */
  LOGIN_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(1000).default(10),
  /** Requests per signed-in session (or per IP when anonymous) per minute. */
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(30).max(100000).default(300),
  /** Days after which local passwords must be changed (0 = no expiry). */
  PASSWORD_MAX_AGE_DAYS: z.coerce.number().int().min(0).max(730).default(0),
  /** 32 bytes in base64. Without it, patient full names cannot be stored (initials + record number only). */
  FIELD_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'deve ter 32 bytes em base64')
    .optional(),
  /** Directory for uploaded files, outside any web root (created with restricted permissions). */
  UPLOAD_DIR: z.string().min(1).default('var/uploads'),
  /** Maximum size of one uploaded file, in MB. */
  UPLOAD_MAX_MB: z.coerce.number().int().min(1).max(20).default(5),
  /** Where attachment contents are kept: local disk (UPLOAD_DIR) or an S3-compatible object store. */
  ATTACHMENT_STORAGE: z.enum(['local', 's3']).default('local'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().min(1).optional(),
  S3_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'nome de bucket inválido').optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  /** true for MinIO and other servers addressed as https://host/bucket/key. */
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  /** Encryption by the object store itself (in addition to the application encryption, when configured). */
  S3_SERVER_SIDE_ENCRYPTION: z.enum(['AES256', 'none']).default('AES256'),
  /** Application encryption of attachment contents (AES-256-GCM): 32 bytes in base64 and a short key name. */
  ATTACHMENT_ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'deve ter 32 bytes em base64').optional(),
  ATTACHMENT_ENCRYPTION_KEY_ID: z.string().regex(/^[a-z0-9-]{1,32}$/, 'use letras minúsculas, números e hífen').optional(),
  /** Previous keys still needed to read older files: "id:base64;id:base64". */
  ATTACHMENT_ENCRYPTION_PREVIOUS_KEYS: z.string().optional(),
  /** off: no scanner (files stay "not verified"); clamav: every file is checked by clamd before it can be downloaded. */
  ANTIVIRUS: z.enum(['off', 'clamav']).default('off'),
  CLAMAV_HOST: z.string().min(1).optional(),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  CLAMAV_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),
  /** sse: screens update as changes are committed; polling: periodic refresh only (infrastructure without long connections). */
  REALTIME_MODE: z.enum(['sse', 'polling']).default('sse'),
  /** Refresh interval used in polling mode and as fallback while the real-time connection is down. */
  REALTIME_POLL_SECONDS: z.coerce.number().int().min(15).max(600).default(60),
  /** How long events stay replayable for reconnecting screens. */
  REALTIME_RETENTION_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  /** Open real-time connections accepted by one API instance. */
  REALTIME_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(10000).default(500),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configuração inválida: ${fields}`);
  }
  if (parsed.data.NODE_ENV === 'production' && !parsed.data.COOKIE_SECURE) {
    throw new Error('Configuração inválida: COOKIE_SECURE deve ser true em produção.');
  }
  const d = parsed.data;
  if (d.ATTACHMENT_STORAGE === 's3') {
    const missing = (['S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const).filter((k) => !d[k]);
    if (missing.length) throw new Error(`Configuração inválida: ATTACHMENT_STORAGE=s3 exige ${missing.join(', ')}.`);
  }
  if (!!d.ATTACHMENT_ENCRYPTION_KEY !== !!d.ATTACHMENT_ENCRYPTION_KEY_ID) throw new Error('Configuração inválida: ATTACHMENT_ENCRYPTION_KEY e ATTACHMENT_ENCRYPTION_KEY_ID são informadas juntas.');
  if (d.ANTIVIRUS === 'clamav' && !d.CLAMAV_HOST) throw new Error('Configuração inválida: ANTIVIRUS=clamav exige CLAMAV_HOST.');
  if (d.NODE_ENV === 'production' && !d.ATTACHMENT_ENCRYPTION_KEY) throw new Error('Configuração inválida: em produção os anexos são cifrados (defina ATTACHMENT_ENCRYPTION_KEY e ATTACHMENT_ENCRYPTION_KEY_ID).');
  return parsed.data;
}
