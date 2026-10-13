import { ORGANIZATION_TYPE_LABEL, isOrganizationType } from '@ccih/domain';
import { createDb } from '../db/client';
import { loadEnv } from '../env';
import { createOrganization } from '../services/organization';
import { argOf, initialPassword } from './prompt';

/**
 * Creates an organization and its creator account (platform operator, on the server):
 *
 *   npm run org:create -w @ccih/api -- --tipo consultoria|hospitalar --nome "<nome>" --login <login> --responsavel "<nome do responsável>"
 *       [--razao-social "<razão social>"] [--cnpj <cnpj>] [--fuso America/Sao_Paulo]
 *
 * The model is chosen here and cannot be changed later by any user. The creator's initial password
 * is typed without echo (or BOOTSTRAP_ADMIN_PASSWORD for automation); never printed or logged.
 */
async function main() {
  const type = argOf('tipo');
  const name = argOf('nome');
  const login = argOf('login');
  const displayName = argOf('responsavel');
  if (!isOrganizationType(type) || !name || !login || !displayName) {
    throw new Error('Uso: npm run org:create -w @ccih/api -- --tipo consultoria|hospitalar --nome "<nome>" --login <login> --responsavel "<nome>" [--razao-social "<...>"] [--cnpj <cnpj>] [--fuso <IANA>]');
  }
  const password = await initialPassword('Senha inicial da conta criadora');
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL, 1);
  try {
    const r = await createOrganization(db, { type, name, legalName: argOf('razao-social') ?? null, cnpj: argOf('cnpj') ?? null, ...(argOf('fuso') ? { timezone: argOf('fuso')! } : {}), founder: { login, password, displayName } });
    process.stdout.write(`Organização "${name}" criada no modelo ${ORGANIZATION_TYPE_LABEL[type]} (id ${r.institutionId}).\n`);
    process.stdout.write(`Conta criadora "${r.founder.login}" criada.\n`);
    if (r.founder.temporaryPassword) process.stdout.write('A senha informada não atende à política (12+ caracteres, 3 tipos): ela vale só para o primeiro acesso, quando a troca é obrigatória.\n');
  } finally {
    await db.destroy();
  }
}

main().catch((e: Error) => {
  process.stderr.write(`Falha: ${e.message}\n`);
  process.exit(1);
});
