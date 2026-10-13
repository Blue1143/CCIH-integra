import { hostname } from 'node:os';
import type { Kysely } from 'kysely';
import { createDb } from '../db/client';
import type { DB } from '../db/types';
import { loadEnv } from '../env';
import { audit, type AuditActor } from '../audit/audit';
import { attachmentLocation, latestScans } from '../services/attachments';
import { scannerFromEnv, type Scanner } from '../services/storage/antivirus';
import { AttachmentVault } from '../services/storage/vault';

/**
 * Maintenance of attachment contents, run by the operator on the server:
 *
 *   npm run attachments -w @ccih/api -- verificar            check every file not yet clean (needs ANTIVIRUS=clamav)
 *   npm run attachments -w @ccih/api -- migrar [--recifrar] [--aplicar]
 *       copy each file to the configured storage (ATTACHMENT_STORAGE) and/or re-encrypt it with the
 *       current key. Without --aplicar only the plan is printed. Each copy is read back and checked
 *       (SHA-256) before it is registered; the source is never deleted.
 *
 * Run only after a backup and with authorization. Prints a report; never prints contents or keys.
 */
const out = (line: string) => process.stdout.write(`${line}\n`);
const actor = (institutionId: string, command: string): AuditActor => ({ institutionId, userId: null, login: 'operacao', ip: null, userAgent: `attachments:${command}@${hostname()}` });

export async function verifyAll(db: Kysely<DB>, vault: AttachmentVault, scanner: Scanner): Promise<Record<string, number>> {
  if (scanner.mode === 'off') throw new Error('ANTIVIRUS=off: configure o antivírus (ANTIVIRUS=clamav) para verificar os arquivos.');
  const rows = await db.selectFrom('attachment').selectAll().orderBy('created_at').execute();
  const scans = await latestScans(db, rows.map((r) => r.id));
  const count: Record<string, number> = { limpo: 0, infectado: 0, erro: 0, ignorado: 0 };
  for (const row of rows) {
    const latest = scans.get(row.id)?.status;
    if (latest === 'limpo' || latest === 'infectado') { count.ignorado!++; continue; }
    const loc = await attachmentLocation(db, row);
    let result;
    try {
      result = await scanner.scan(await vault.read(loc));
    } catch (e) {
      result = { status: 'erro' as const, engine: 'leitura', signature: null, detail: (e as Error).message };
    }
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('attachment_scan').values({ institution_id: row.institution_id, attachment_id: row.id, status: result.status, engine: result.engine, signature: result.signature, detail: result.detail, requested_by: null, requested_by_name: 'Verificação em lote' }).execute();
      await audit(trx, actor(row.institution_id, 'verificar'), { action: 'scan', entity: 'attachment', entityId: row.id, after: { status: result.status, engine: result.engine, signature: result.signature } });
    });
    if (result.status === 'infectado') await vault.remove(loc).catch(() => undefined);
    count[result.status]!++;
    out(`${row.id}  ${result.status}${result.signature ? `  ${result.signature}` : ''}${result.detail ? `  ${result.detail}` : ''}`);
  }
  return count;
}

export async function migrateAll(db: Kysely<DB>, vault: AttachmentVault, opts: { reencrypt: boolean; apply: boolean; operator: string }): Promise<Record<string, number>> {
  const rows = await db.selectFrom('attachment').selectAll().orderBy('created_at').execute();
  const scans = await latestScans(db, rows.map((r) => r.id));
  const count: Record<string, number> = { copiado: 0, planejado: 0, ja_no_destino: 0, descartado: 0, falha: 0 };
  for (const row of rows) {
    if (scans.get(row.id)?.status === 'infectado') { count.descartado!++; continue; }
    const loc = await attachmentLocation(db, row);
    const needsMove = loc.backend !== vault.backend;
    const needsKey = opts.reencrypt && loc.keyId !== vault.currentKeyId;
    if (!needsMove && !needsKey) { count.ja_no_destino!++; continue; }
    const what = `${loc.backend}/${loc.keyId ?? 'sem cifra'} → ${vault.backend}/${(opts.reencrypt ? vault.currentKeyId : loc.keyId) ?? 'sem cifra'}`;
    if (!opts.apply) { count.planejado!++; out(`${row.id}  planejado  ${what}`); continue; }
    try {
      const next = await vault.copy(loc, row.institution_id, vault.backend, opts.reencrypt ? vault.currentKeyId : loc.keyId);
      await db.transaction().execute(async (trx) => {
        await trx.insertInto('attachment_copy').values({ institution_id: row.institution_id, attachment_id: row.id, storage_backend: next.backend, storage_key: next.fileId, encryption: next.encryption, key_id: next.keyId, sha256: next.sha256, operator: opts.operator }).execute();
        await audit(trx, actor(row.institution_id, 'migrar'), { action: 'copy', entity: 'attachment', entityId: row.id, before: { storage: loc.backend, keyId: loc.keyId }, after: { storage: next.backend, keyId: next.keyId, sha256: next.sha256 }, context: { operator: opts.operator } });
      });
      count.copiado!++;
      out(`${row.id}  copiado  ${what}  SHA-256 conferido`);
    } catch (e) {
      count.falha!++;
      out(`${row.id}  FALHA  ${what}  ${(e as Error).message}`);
    }
  }
  return count;
}

async function main() {
  const [command, ...flags] = process.argv.slice(2);
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL, 2);
  try {
    const vault = AttachmentVault.fromEnv(env);
    if (command === 'verificar') {
      const c = await verifyAll(db, vault, scannerFromEnv(env));
      out(`Resumo: ${Object.entries(c).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    } else if (command === 'migrar') {
      const operator = process.env.USER ?? 'operador';
      const c = await migrateAll(db, vault, { reencrypt: flags.includes('--recifrar'), apply: flags.includes('--aplicar'), operator });
      out(`Resumo: ${Object.entries(c).map(([k, v]) => `${k}=${v}`).join(', ')}`);
      if (!flags.includes('--aplicar')) out('Nada foi copiado (simulação). Repita com --aplicar depois do backup e da autorização.');
      if (c.falha) process.exitCode = 2;
    } else {
      throw new Error('Uso: npm run attachments -w @ccih/api -- verificar | migrar [--recifrar] [--aplicar]');
    }
  } finally {
    await db.destroy();
  }
}

if (process.argv[1] && /attachments\.(ts|js)$/.test(process.argv[1])) {
  main().catch((e: Error) => {
    process.stderr.write(`Falha: ${e.message}\n`);
    process.exit(1);
  });
}
