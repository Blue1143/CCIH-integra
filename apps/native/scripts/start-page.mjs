// Writes www/ (the page the apps open first) with the server address of this build.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { serverOrigin } from './server-url.mjs';

const origin = serverOrigin(process.env.CCIH_SERVER_URL);
const out = new URL('../www/', import.meta.url);
mkdirSync(out, { recursive: true });
for (const file of ['index.html', 'start.css', 'start.js']) {
  const text = readFileSync(new URL(`../start/${file}`, import.meta.url), 'utf8');
  writeFileSync(new URL(file, out), text.replaceAll('__CCIH_SERVER_JSON__', JSON.stringify(origin)).replaceAll('__CCIH_SERVER__', origin));
}
// Capacitor (Android and iPhone): the web view may navigate only to this server; everything else opens outside.
const capacitor = {
  appId: process.env.CCIH_APP_ID ?? 'br.ccihintegra.mobile',
  appName: 'CCIH Integra',
  webDir: 'www',
  server: { androidScheme: 'https', allowNavigation: [new URL(origin).hostname] },
  android: { allowMixedContent: false, webContentsDebuggingEnabled: false },
  ios: { contentInset: 'automatic', webContentsDebuggingEnabled: false },
};
writeFileSync(new URL('../capacitor.config.json', import.meta.url), `${JSON.stringify(capacitor, null, 2)}\n`);
console.warn(`Página de conexão gerada para ${origin}`);
