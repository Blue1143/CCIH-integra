import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env';

const base = { DATABASE_URL: 'postgres://u:p@localhost/db', APP_ORIGIN: 'https://ccih.exemplo' };
const prodKey = { ATTACHMENT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), ATTACHMENT_ENCRYPTION_KEY_ID: 'k2026a' };

describe('environment', () => {
  it('refuses to start without required settings', () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });

  it('treats empty variables as not set (containers pass optional settings empty)', () => {
    const env = loadEnv({ ...base, ...prodKey, NODE_ENV: 'production', FIELD_ENCRYPTION_KEY: '', S3_BUCKET: '', ATTACHMENT_ENCRYPTION_PREVIOUS_KEYS: '' });
    expect(env.FIELD_ENCRYPTION_KEY).toBeUndefined();
    expect(() => loadEnv({ ...base, ...prodKey, NODE_ENV: 'production', ATTACHMENT_ENCRYPTION_KEY: '' })).toThrow(/ATTACHMENT_ENCRYPTION_KEY/);
  });

  it('requires secure cookies in production', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE/);
    expect(loadEnv({ ...base, ...prodKey, NODE_ENV: 'production' }).COOKIE_SECURE).toBe(true);
  });

  it('requires encrypted attachments in production, and complete storage and antivirus settings', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production' })).toThrow(/ATTACHMENT_ENCRYPTION_KEY/);
    expect(() => loadEnv({ ...base, ATTACHMENT_ENCRYPTION_KEY: prodKey.ATTACHMENT_ENCRYPTION_KEY })).toThrow(/juntas/);
    expect(() => loadEnv({ ...base, ATTACHMENT_ENCRYPTION_KEY: 'curta', ATTACHMENT_ENCRYPTION_KEY_ID: 'k1' })).toThrow(/32 bytes/);
    expect(() => loadEnv({ ...base, ATTACHMENT_STORAGE: 's3', S3_BUCKET: 'ccih-anexos' })).toThrow(/S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY/);
    expect(() => loadEnv({ ...base, ANTIVIRUS: 'clamav' })).toThrow(/CLAMAV_HOST/);
    expect(loadEnv({ ...base }).ANTIVIRUS).toBe('off');
  });
});
