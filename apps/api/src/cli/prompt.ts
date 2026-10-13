import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

/** Reads a value from the terminal without echo (passwords are never printed). */
export async function askHidden(question: string): Promise<string> {
  let muted = false;
  const out = new Writable({ write: (chunk, _enc, cb) => { if (!muted) process.stdout.write(chunk); cb(); } });
  const rl = createInterface({ input: process.stdin, output: out, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
    muted = true;
  });
}

export const argOf = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/** Initial password: BOOTSTRAP_ADMIN_PASSWORD (automation, never in files) or typed twice without echo. */
export async function initialPassword(label: string): Promise<string> {
  const fromEnv = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) throw new Error('Sem terminal interativo: defina BOOTSTRAP_ADMIN_PASSWORD só para esta execução.');
  const password = await askHidden(`${label}: `);
  const again = await askHidden('Repita a senha: ');
  if (password !== again) throw new Error('As senhas não conferem.');
  return password;
}
