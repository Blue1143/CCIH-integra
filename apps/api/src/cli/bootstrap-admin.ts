import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { createDb } from '../db/client';
import { loadEnv } from '../env';
import { createFounder } from '../services/founder';

/**
 * Creates the creator account:  npm run admin:bootstrap -w @ccih/api -- --login <login> --nome "<nome>"
 * The password is typed in the terminal without echo (or, in automation, read from the environment
 * variable BOOTSTRAP_ADMIN_PASSWORD, which must not be stored in files). It is never printed or logged.
 */
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function askHidden(question: string): Promise<string> {
  let muted = false;
  const out = new Writable({ write: (chunk, _enc, cb) => { if (!muted) process.stdout.write(chunk); cb(); } });
  const rl = createInterface({ input: process.stdin, output: out, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
    muted = true;
  });
}

async function main() {
  const login = arg('login');
  const displayName = arg('nome') ?? 'Administrador criador';
  if (!login) throw new Error('Uso: npm run admin:bootstrap -w @ccih/api -- --login <login> [--nome "<nome>"] [--instituicao <id>]');
  let password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!password) {
    if (!process.stdin.isTTY) throw new Error('Sem terminal interativo: defina BOOTSTRAP_ADMIN_PASSWORD só para esta execução.');
    password = await askHidden('Senha inicial da conta criadora: ');
    const again = await askHidden('Repita a senha: ');
    if (password !== again) throw new Error('As senhas não conferem.');
  }
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
