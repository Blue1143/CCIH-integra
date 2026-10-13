import { Socket } from 'node:net';

/**
 * Antivirus check of uploaded files through clamd, with the INSTREAM command documented by ClamAV:
 * "zINSTREAM\0", then chunks prefixed by their length (4 bytes, big endian), then a zero length.
 * The reply is "stream: OK", "stream: <signature> FOUND" or an error.
 */
export interface ScanResult { status: 'limpo' | 'infectado' | 'erro'; engine: string; signature: string | null; detail: string | null }

export interface Scanner {
  readonly mode: 'off' | 'clamav';
  scan(data: Buffer): Promise<ScanResult>;
  /** Throws when the scanner cannot be used (for the readiness check). */
  probe(): Promise<void>;
}

export const NO_SCANNER: Scanner = {
  mode: 'off',
  scan: async () => { throw new Error('Antivírus não configurado.'); },
  probe: async () => undefined,
};

const CHUNK = 64 * 1024;

function talk(host: string, port: number, timeoutMs: number, frames: Buffer[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const parts: Buffer[] = [];
    const fail = (e: Error) => { socket.destroy(); reject(e); };
    socket.setTimeout(timeoutMs, () => fail(new Error('Tempo esgotado na resposta do antivírus.')));
    socket.once('error', fail);
    socket.on('data', (d) => parts.push(d));
    socket.once('end', () => resolve(Buffer.concat(parts).toString('utf8').replace(/\0+$/, '').trim()));
    socket.connect(port, host, () => {
      for (const f of frames) socket.write(f);
    });
  });
}

export class ClamAvScanner implements Scanner {
  readonly mode = 'clamav' as const;
  constructor(private readonly host: string, private readonly port: number, private readonly timeoutMs: number) {}

  async version(): Promise<string> {
    try {
      return await talk(this.host, this.port, this.timeoutMs, [Buffer.from('zVERSION\0')]);
    } catch {
      return 'ClamAV';
    }
  }

  async scan(data: Buffer): Promise<ScanResult> {
    const frames: Buffer[] = [Buffer.from('zINSTREAM\0')];
    for (let i = 0; i < data.length; i += CHUNK) {
      const chunk = data.subarray(i, i + CHUNK);
      const len = Buffer.alloc(4);
      len.writeUInt32BE(chunk.length);
      frames.push(len, chunk);
    }
    frames.push(Buffer.alloc(4));
    let reply: string;
    try {
      reply = await talk(this.host, this.port, this.timeoutMs, frames);
    } catch (e) {
      return { status: 'erro', engine: 'ClamAV', signature: null, detail: `Antivírus indisponível: ${(e as Error).message}` };
    }
    const engine = await this.version();
    if (/^stream: OK$/.test(reply)) return { status: 'limpo', engine, signature: null, detail: null };
    const found = /^stream: (.+) FOUND$/.exec(reply);
    if (found) return { status: 'infectado', engine, signature: found[1]!.slice(0, 200), detail: null };
    return { status: 'erro', engine, signature: null, detail: `Resposta do antivírus: ${reply.slice(0, 200) || 'vazia'}` };
  }

  async probe() {
    const r = await talk(this.host, this.port, this.timeoutMs, [Buffer.from('zPING\0')]);
    if (r !== 'PONG') throw new Error(`Antivírus respondeu "${r.slice(0, 40)}" ao PING.`);
  }
}

export const scannerFromEnv = (env: { ANTIVIRUS: 'off' | 'clamav'; CLAMAV_HOST?: string | undefined; CLAMAV_PORT: number; CLAMAV_TIMEOUT_MS: number }): Scanner =>
  env.ANTIVIRUS === 'clamav' ? new ClamAvScanner(env.CLAMAV_HOST!, env.CLAMAV_PORT, env.CLAMAV_TIMEOUT_MS) : NO_SCANNER;
