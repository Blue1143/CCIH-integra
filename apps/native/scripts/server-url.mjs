/**
 * Address of the organization's server, fixed in each build of the apps (CCIH_SERVER_URL).
 * HTTPS is required: the session cookie is Secure and the apps never talk to the server in clear
 * text. Plain HTTP is accepted only for this computer (development).
 */
export function serverOrigin(value) {
  if (!value) throw new Error('Defina CCIH_SERVER_URL com o endereço do servidor (ex.: https://ccih.escritorio.ts.net).');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`CCIH_SERVER_URL inválida: ${value}`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('CCIH_SERVER_URL deve usar https:// (http:// só para este computador, em desenvolvimento).');
  if (url.username || url.password) throw new Error('CCIH_SERVER_URL não pode conter usuário ou senha.');
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) throw new Error('CCIH_SERVER_URL deve ser só o endereço do servidor, sem caminho (o sistema fica na raiz).');
  return url.origin;
}
