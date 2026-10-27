# Publicação do CCIH Integra (site público para testes reais)

Este guia coloca o sistema completo (banco, API e site com HTTPS) em **um servidor** com Docker. Serve para a fase de testes reais com organizações de verdade (consultorias e hospitais), e é a base da produção.

O repositório não guarda nenhum segredo: senhas e chaves são geradas no próprio servidor e ficam só no arquivo `deploy/.env`, que o git ignora.

## 1. O que é preciso

| Item | Recomendação |
| --- | --- |
| Servidor | VPS Linux (Ubuntu 24.04 LTS ou Debian 12) com **2 vCPU, 4 GB de RAM e 40 GB de disco**; com o antivírus, 6 GB de RAM. **Preferir região no Brasil** (dados de saúde e LGPD). |
| Software | Docker Engine e o plugin Docker Compose (`docker compose version`). |
| Domínio | Um nome (ex.: `ccih.suaconsultoria.com.br`) com registro **A** (e AAAA, se houver IPv6) apontando para o IP do servidor. |
| Rede | Portas **80 e 443** abertas para a internet (o certificado HTTPS é emitido sozinho pela Let's Encrypt). SSH só por chave. Nenhuma outra porta aberta: o banco não é publicado. |
| Contrato com o provedor | Termo de tratamento de dados (operador, LGPD) e local do armazenamento por escrito. |

## 2. Primeira instalação

```sh
# No servidor, como usuário com acesso ao Docker
sudo mkdir -p /opt/ccih-integra && sudo chown "$USER" /opt/ccih-integra
git clone <url-do-repositório> /opt/ccih-integra
cd /opt/ccih-integra
git checkout <branch ou tag aprovada>

cd deploy
cp .env.example .env
chmod 600 .env
```

Preencha o `deploy/.env` (um editor de texto no servidor; nunca envie este arquivo por e-mail ou chat):

| Variável | Como preencher |
| --- | --- |
| `SITE_ADDRESS` | O domínio, sem `https://` (ex.: `ccih.suaconsultoria.com.br`) |
| `APP_ORIGIN` | `https://` + o domínio |
| `DB_OWNER_PASSWORD`, `DB_APP_PASSWORD` | `openssl rand -hex 24` (uma para cada) |
| `ATTACHMENT_ENCRYPTION_KEY` | `openssl rand -base64 32`. **Guarde uma cópia fora do servidor** (cofre de senhas da organização): sem ela os anexos não podem ser lidos |
| `ATTACHMENT_ENCRYPTION_KEY_ID` | Um nome curto da chave, ex.: `k1` |
| `FIELD_ENCRYPTION_KEY` | Só no modelo hospitalar, se for guardar o nome completo de pacientes: `openssl rand -base64 32` (também guardada fora) |

Suba tudo:

```sh
docker compose up -d --build
docker compose ps            # db, api e web "running"; migrate "exited (0)"
curl -fsS https://SEU-DOMINIO/api/ready
```

`/api/ready` responde `{"status":"pronto",...}` quando o banco responde e todas as migrações foram aplicadas. Enquanto houver migração pendente, responde **503**.

## 3. Criar as organizações (operador da plataforma)

A organização nasce vazia, com os perfis do seu modelo, e com uma conta criadora. A senha inicial é digitada no terminal, sem eco e sem ficar em log:

```sh
cd /opt/ccih-integra/deploy
docker compose run --rm -it api node dist/org-create.js \
  --tipo consultoria --nome "Consultoria Exemplo" --login dono.exemplo --responsavel "Nome do responsável" \
  [--razao-social "Razão social"] [--cnpj 00.000.000/0000-00]

docker compose run --rm -it api node dist/org-create.js \
  --tipo hospitalar --nome "Hospital Exemplo" --login admin.hospital --responsavel "Nome do responsável"
```

Depois, a conta criadora entra pelo site, troca a senha (se tiver sido marcada como temporária) e cadastra a equipe em **Administração → Gestão de usuários**. Na consultoria: clientes, contratos e distribuição da carteira; no hospital: setores, parâmetros e equipe.

> **Dados de demonstração** não são carregados em produção (o comando recusa). Para uma instância de **homologação** separada, com os dados sintéticos para treinamento, veja a seção 8.

## 4. Atualizar para uma nova versão

```sh
cd /opt/ccih-integra
./deploy/backup.sh                      # rode a partir de deploy/: cd deploy && ./backup.sh
git fetch && git checkout <nova versão aprovada>
cd deploy && docker compose up -d --build
curl -fsS https://SEU-DOMINIO/api/ready
```

As migrações rodam sozinhas antes da API (serviço `migrate`). Elas só acrescentam; nenhuma apaga dados. Se a migração falhar, a API não sobe e a versão anterior do banco fica intacta: restaure a versão anterior do código (`git checkout` da versão anterior e `docker compose up -d --build`).

## 5. Cópias de segurança

```sh
cd /opt/ccih-integra/deploy
./backup.sh            # banco (pg_dump) e anexos, em deploy/backups/, mantendo as 14 últimas
```

Agende diariamente (cron do servidor) e **copie a pasta `backups/` para fora do servidor** (outro provedor ou armazenamento da organização). Teste a restauração periodicamente:

```sh
# Restauração do banco numa instalação nova (com os containers parados, exceto o db)
docker compose up -d db
docker compose exec -T db pg_restore -U ccih_owner -d ccih --clean --if-exists < backups/ccih-AAAAMMDD-HHMMSS.dump
docker compose run --rm --no-deps -T --entrypoint tar api -xzf - -C /app/apps/api < backups/anexos-AAAAMMDD-HHMMSS.tar.gz
docker compose up -d
```

Os anexos estão cifrados: a cópia só é útil com a `ATTACHMENT_ENCRYPTION_KEY` guardada à parte.

## 6. Conferências periódicas

| O quê | Como |
| --- | --- |
| Sistema no ar | `curl -fsS https://SEU-DOMINIO/api/ready` (pode ser usado por um monitor externo de disponibilidade) |
| Integridade do log de auditoria | `docker compose run --rm api node dist/cli.js verify-audit` |
| Anexos íntegros | `docker compose run --rm api node dist/attachments.js verificar` |
| Logs | `docker compose logs --since 24h api` (não contêm senhas nem conteúdo de anexos) |
| Atualizações de segurança | Sistema operacional do servidor com atualizações automáticas; `docker compose pull` das imagens base a cada versão |

## 7. Antivírus (opcional, recomendado com anexos de clientes)

No `.env`: `ANTIVIRUS=clamav`. Suba com o perfil:

```sh
docker compose --profile antivirus up -d --build
```

O ClamAV baixa as assinaturas na primeira subida (alguns minutos e cerca de 1 GB de RAM). Enquanto ele não responde, os anexos novos ficam "aguardando verificação" e não são liberados para download.

## 8. Homologação com dados de demonstração (instância separada)

Para treinar a equipe sem dados reais, use **outro servidor ou outra pasta com outro domínio** (ex.: `homologacao.suaconsultoria.com.br`) e outro `.env`. Nessa instância, depois da primeira subida:

```sh
docker compose run --rm -e NODE_ENV=development -e SEED_PASSWORD='<senha forte escolhida>' api node dist/cli.js seed
```

Todos os usuários sintéticos usam a senha informada (nunca a mesma da produção). Os dados ficam marcados como "Sintético" nas telas. **Nunca rode o seed na instância de produção.**

## 9. Antes de receber dados reais

- [ ] Domínio com HTTPS válido e `/api/ready` respondendo "pronto".
- [ ] `deploy/.env` com permissão 600, chaves guardadas fora do servidor e senhas únicas.
- [ ] Backup diário agendado, copiado para fora do servidor e **uma restauração testada**.
- [ ] Firewall: só 80/443 (e SSH por chave).
- [ ] Termo de tratamento de dados com o provedor e região de armazenamento definida.
- [ ] Organizações criadas pelo comando do operador; contas criadoras com senha trocada.
- [ ] Modelo de consultoria: só dados agregados mensais dos clientes, **sem dados de pacientes** (decisão D2).
- [ ] Modelo hospitalar: avaliação de impacto (LGPD) antes de registrar pacientes reais.

A separação técnica por organização, cliente e função **não é, por si só, garantia de conformidade** com a LGPD ou com normas sanitárias; a avaliação jurídica e de segurança da informação da organização continua necessária.

## Arquivos

| Arquivo | Para quê |
| --- | --- |
| `Dockerfile` | Imagens da API (Node 22, usuário sem privilégio) e da web (Caddy com HTTPS automático) |
| `deploy/docker-compose.yml` | Banco, migração, API, proxy e antivírus opcional |
| `deploy/Caddyfile` | HTTPS, cabeçalhos de segurança, `/api` para a API (com tempo real sem buffer) e a aplicação web |
| `deploy/initdb/01-app-role.sh` | Cria o papel da aplicação (sem DDL) na primeira subida do banco |
| `deploy/.env.example` | Modelo do `.env` (sem valores) |
| `deploy/backup.sh` | Cópia do banco e dos anexos |
| `.github/workflows/ci.yml` (job `publicacao`) | A cada envio, constrói as imagens, sobe tudo e confere `/api/ready`, a web e os cabeçalhos |
