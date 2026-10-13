import { createDb } from '../db/client';
import { loadEnv } from '../env';
import { createFounder } from '../services/founder';
import { argOf as arg, initialPassword } from './prompt';

/**
 * Creates the creator account:  npm run admin:bootstrap -w @ccih/api -- --login <login> --nome "<nome>"
 * The password is typed in the terminal without echo (or, in automation, read from the environment
 * variable BOOTSTRAP_ADMIN_PASSWORD, which must not be stored in files). It is never printed or logged.
 */
async function main() {
  const login = arg('login');
  const displayName = arg('nome') ?? 'Administrador criador';
  if (!login) throw new Error('Uso: npm run admin:bootstrap -w @ccih/api -- --login <login> [--nome "<nome>"] [--instituicao <id>]');
  const password = await initialPassword('Senha inicial da conta criadora');
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL, 1);
  try {
    const r = await createFounder(db, { login, password, displayName, institutionId: arg('instituicao') });
    process.stdout.write(`Conta criadora "${r.login}" criada.\n`);
    if (r.temporaryPassword) process.stdout.write('A senha informada não atende à política (12+ caracteres, 3 tipos): ela vale só para o primeiro acesso, quando a troca é obrigatória.\n');
  } finally {
    await db.destroy();
  }
}

main().catch((e: Error) => {
  console.error(`Falha: ${e.message}`);
  process.exit(1);
});
