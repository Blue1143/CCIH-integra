# Aplicativos instalados e servidor no escritório

O CCIH Integra pode ser usado por **aplicativos instalados** (Windows, Mac, Android e iPhone), sem site público na internet. Os dados ficam num **computador do escritório**; os aplicativos se conectam a ele pela **VPN da equipe**, com HTTPS.

```
 Consultores (Windows, Mac, Android, iPhone)
        │  aplicativo CCIH Integra
        │  HTTPS dentro da VPN (Tailscale)
        ▼
 Computador do escritório ── Docker: banco + API + proxy (só acessível pela VPN)
```

- Os aplicativos **não guardam dados no aparelho**: abrem o sistema do servidor, com o mesmo login, permissões, auditoria e proteções da versão web. Todos os aparelhos veem as mesmas informações, sempre atualizadas.
- Cada nova etapa do sistema chega aos aplicativos sem reinstalar: basta atualizar o servidor.
- Sem internet ou fora da VPN, o aplicativo mostra o aviso e tenta de novo. Não há registro offline (decisão: não é necessário).

## 1. O computador do escritório

| Item | Recomendação |
| --- | --- |
| Máquina | Computador sempre ligado (desktop ou mini PC), 4 núcleos, **8 GB de RAM**, SSD de 256 GB, nobreak. Windows 10/11 Pro, macOS ou Linux (Ubuntu 24.04) |
| Software | Docker Desktop (Windows/Mac) ou Docker Engine (Linux), e Tailscale |
| Energia e rede | Sem suspensão automática; cabo de rede; reinício automático após queda de energia, se a BIOS permitir |
| Cópias | Backup diário (seção 5) copiado para fora do escritório |

### 1.1 Instalar o sistema

Siga as seções 2 e 3 de [01-PUBLICACAO.md](01-PUBLICACAO.md) (clone do repositório, `deploy/.env`, criação das organizações), com estas diferenças no `.env`:

```
# O HTTPS é feito pelo Tailscale; o proxy atende só este computador.
SITE_ADDRESS=:80
APP_ORIGIN=https://<nome-do-computador>.<sua-rede>.ts.net
```

e suba com o arquivo do escritório (o proxy fica preso a este computador, na porta 8080):

```sh
cd deploy
docker compose -f docker-compose.yml -f docker-compose.escritorio.yml up -d --build
```

### 1.2 Acesso seguro pela VPN (Tailscale)

1. Crie a rede da equipe em tailscale.com (conta da organização) e instale o Tailscale **no computador do escritório**.
2. No painel do Tailscale, ative **MagicDNS** e **HTTPS Certificates**.
3. No computador do escritório, publique o sistema só para a rede da equipe:
   ```sh
   tailscale serve --bg http://127.0.0.1:8080
   ```
   O endereço do sistema passa a ser `https://<nome-do-computador>.<sua-rede>.ts.net`, com certificado válido emitido para a rede. **Não use `tailscale funnel`**, que abriria o sistema na internet.
4. Instale o Tailscale em cada aparelho da equipe (Windows, Mac, Android, iPhone), entre com a conta da organização e mantenha-o ligado.
5. Teste num aparelho: `https://<nome-do-computador>.<sua-rede>.ts.net/api/ready` deve responder `{"status":"pronto"}`.

> Alternativas ao Tailscale: outra VPN da organização (WireGuard, a VPN do roteador) com um certificado HTTPS confiável nos aparelhos. O aplicativo exige HTTPS; o login não funciona sem ele.

## 2. Gerar os instaladores

No GitHub do projeto: **Actions → Aplicativos → Run workflow**, informando o endereço do servidor (ex.: `https://servidor-ccih.minharede.ts.net`). Ao final, baixe em **Artifacts**:

| Arquivo | Para |
| --- | --- |
| `ccih-integra-Windows` | Instalador `.exe` (e `.msi`) para Windows 10/11 |
| `ccih-integra-macOS` | `.dmg` para Mac (Intel e Apple Silicon) |
| `ccih-integra-android` | `.apk` para Android |
| — (iPhone) | Ver 3.4: exige a conta Apple da organização |

O endereço do servidor fica gravado no aplicativo; se ele mudar, gere os instaladores de novo. O aplicativo **só abre o servidor configurado**: qualquer outro endereço é bloqueado dentro da janela.

## 3. Instalar nos aparelhos

Os instaladores desta fase **não têm assinatura de empresa** (certificados pagos, ver 3.5). Por isso o sistema operacional avisa na primeira instalação:

1. **Windows:** execute o `.exe`. Se aparecer "O Windows protegeu o computador", clique em *Mais informações → Executar assim mesmo*.
2. **Mac:** abra o `.dmg` e arraste o CCIH Integra para Aplicativos. Na primeira abertura, clique com o botão direito no aplicativo → *Abrir* → *Abrir*.
3. **Android:** envie o `.apk` ao aparelho, abra-o e permita "instalar apps desta fonte" quando pedido. A câmera é pedida na primeira leitura de código de barras da CME.
4. **iPhone:** a Apple não permite instalar fora da App Store sem a conta de desenvolvedor da organização. Com a conta (Apple Developer Program, anual), o aplicativo é distribuído internamente pelo **TestFlight** ou como app personalizado no **Apple Business Manager**, sem ficar público na App Store. Até lá, os usuários de iPhone podem usar o Safari com o mesmo endereço (*Compartilhar → Adicionar à Tela de Início*), que se comporta como aplicativo.
5. **Assinaturas para produção** (recomendadas antes de distribuir a toda a equipe): certificado de assinatura de código para Windows, conta Apple Developer para Mac (notarização) e iPhone, e chave de assinatura própria para Android. As chaves ficam nos segredos do GitHub, nunca no repositório. Quando a organização tiver as contas, a automação passa a assinar.

## 4. Atualizar

- **O sistema:** atualize o servidor do escritório ([01-PUBLICACAO.md](01-PUBLICACAO.md), seção 4). Os aplicativos mostram a nova versão na próxima abertura.
- **O aplicativo em si** (raramente: mudança do endereço do servidor, do ícone, do Tauri ou do Capacitor): gere e instale os instaladores de novo.

## 5. Cópias de segurança

Como em [01-PUBLICACAO.md](01-PUBLICACAO.md), seção 5: `./backup.sh` diário, agendado no computador do escritório (Agendador de Tarefas no Windows, cron no Linux/Mac), com cópia **para fora do escritório**. Um computador local pode ser perdido (furto, incêndio, defeito do disco): sem a cópia externa, os dados se perdem.

## O que foi verificado e o que falta verificar nos aparelhos

| Verificação | Situação |
| --- | --- |
| Aplicativo de computador compilado e executado (Linux, mesmo código do Windows/Mac): página de conexão → login → início da consultoria, com tempo real conectado | Feito |
| Navegação presa ao servidor configurado (teste automático) | Feito |
| Instaladores de Windows e Mac, APK Android e compilação para o simulador do iPhone | Pela automação do GitHub a cada mudança |
| Em aparelhos reais: login, leitura de código pela câmera (Android/iPhone), download de anexos e da agenda `.ics` dentro do aplicativo | **A verificar na instalação** (o comportamento de downloads varia entre Windows, Mac, Android e iPhone) |
