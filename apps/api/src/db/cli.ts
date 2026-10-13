import { writeFileSync } from 'node:fs';
import { createDb } from './client';
import { grantAppRole, migrateToLatest, resetSchema } from './migrate';
import { seedDemo } from './seed';
import { seedDemoConsulting } from './seed-consulting';
import { verifyAuditChain } from '../audit/audit';

/**
 * Database commands: migrate | reset | seed | verify-audit.
 * Migrations run with DATABASE_OWNER_URL; the app role (from DATABASE_URL) only receives DML grants.
 */
const command = process.argv[2];
const ownerUrl = process.env.DATABASE_OWNER_URL;
const appUrl = process.env.DATABASE_URL;
const isProduction = process.env.NODE_ENV === 'production';

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Defina ${name}.`);
  return value;
}

async function migrate(reset: boolean) {
  const owner = createDb(required('DATABASE_OWNER_URL', ownerUrl), 1);
  try {
    if (reset) {
      if (isProduction) throw new Error('db:reset é proibido em produção.');
      await resetSchema(owner);
    }
    const applied = await migrateToLatest(owner);
    await grantAppRole(owner, new URL(required('DATABASE_URL', appUrl)).username);
    console.warn(applied.length ? `Migrações aplicadas: ${applied.join(', ')}` : 'Banco já está na versão mais recente.');
  } finally {
    await owner.destroy();
  }
}

async function seed() {
  if (isProduction) throw new Error('O seed de demonstração não roda em produção.');
  const db = createDb(required('DATABASE_URL', appUrl), 2);
  try {
    const opts = process.env.SEED_PASSWORD ? { password: process.env.SEED_PASSWORD } : {};
    const result = await seedDemo(db, opts);
    // A second, empty organization of the consulting model (its own login; no data shared with the hospital).
    const consulting = await seedDemoConsulting(db, opts);
    const credentials = [...result.credentials, ...consulting.credentials];
    const file = '.seed-credentials.local';
    writeFileSync(file, credentials.map((c) => `${c.login}\t${c.role}\t${c.password}`).join('\n') + '\n', { mode: 0o600 });
    console.warn(`Ambiente de demonstração criado: hospital com ${result.credentials.length} usuários sintéticos e ${result.facts} fatos mensais; consultoria de demonstração com o usuário "consultoria".`);
    console.warn(`Credenciais de demonstração gravadas em apps/api/${file} (arquivo ignorado pelo git).`);
  } finally {
    await db.destroy();
  }
}

async function verify() {
  const db = createDb(required('DATABASE_URL', appUrl), 1);
  try {
    const r = await verifyAuditChain(db);
    console.warn(r.ok ? `Cadeia de auditoria íntegra (${r.checked} registros).` : `CADEIA VIOLADA no registro ${r.brokenAtId}.`);
    if (!r.ok) process.exitCode = 2;
  } finally {
    await db.destroy();
  }
}

const run: Record<string, () => Promise<void>> = {
  migrate: () => migrate(false),
  reset: async () => { await migrate(true); await seed(); },
  seed,
  'verify-audit': verify,
};

const fn = command ? run[command] : undefined;
if (!fn) {
  console.error('Uso: cli.ts migrate | reset | seed | verify-audit');
  process.exitCode = 1;
} else {
  fn().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
