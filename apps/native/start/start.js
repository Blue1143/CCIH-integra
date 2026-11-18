// Opens the organization's system once its server answers as ready; otherwise explains and retries.
const SERVER = __CCIH_SERVER_JSON__;
const status = document.getElementById('status');
const retry = document.getElementById('retry');

async function connect() {
  retry.hidden = true;
  status.textContent = 'Conectando ao servidor da organização…';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`${SERVER}/api/ready`, { cache: 'no-store', credentials: 'omit', signal: controller.signal });
    if (res.ok) {
      location.replace(`${SERVER}/`);
      return;
    }
    const body = await res.json().catch(() => ({}));
    status.textContent = body.status === 'migracao_pendente'
      ? 'O servidor está sendo atualizado. Tente de novo em alguns minutos.'
      : 'O servidor respondeu, mas não está pronto. Avise o responsável pelo sistema.';
  } catch {
    status.textContent = navigator.onLine === false
      ? 'Sem conexão com a internet neste aparelho.'
      : 'Não foi possível alcançar o servidor. Verifique a conexão com a rede do escritório (VPN) e tente de novo.';
  } finally {
    clearTimeout(timer);
  }
  retry.hidden = false;
}

retry.addEventListener('click', () => void connect());
window.addEventListener('online', () => void connect());
void connect();
