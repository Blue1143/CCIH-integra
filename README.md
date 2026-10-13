# CCIH Integra

Plataforma de gestão integrada da CCIH/SCIRAS: vigilância epidemiológica de IRAS, indicadores, bundles, auditorias, CME e rastreabilidade, microbiologia, stewardship de antimicrobianos e segurança do paciente.

> **Estado atual: Fases 1 a 5 concluídas.** Front-end (React), API (Fastify) e banco (PostgreSQL) com autenticação, perfis aplicados no servidor, log de auditoria imutável, configurações editáveis, o **core clínico** (pacientes, internações, dispositivos, censo diário, vigilância de IRAS, cirurgias e microbiologia) e a **CCIH operacional** (bundles, higiene das mãos, auditorias e não conformidades com 5W2H, Central de Alertas, treinamentos, insumos e vigilância pós-alta de ISC) e a **CME com rastreabilidade** (equipamentos, cargas e ciclos, Bowie-Dick, indicadores químicos e biológicos, liberação pela política versionada, uso dos pacotes nas cirurgias e pesquisa até o paciente). O banco de desenvolvimento é preenchido com **dados sintéticos** (sem pacientes reais), sinalizados em toda tela. Próxima etapa: stewardship de antimicrobianos (Fase 6) — veja [docs/ROADMAP.md](docs/ROADMAP.md).

## O que já funciona

- **Acesso**: login com bloqueio por tentativas e limite por IP, limite geral de requisições por sessão, sessão em cookie `HttpOnly`/`SameSite=Strict` com expiração por inatividade e tempo máximo, aviso antes de expirar, saída que limpa todos os dados em cache (estações compartilhadas).
- **Senhas**: cada usuário troca a própria senha em **Minha conta** (as outras sessões são encerradas). Usuário novo ou com senha redefinida pelo administrador recebe uma **senha temporária exibida uma única vez** e só acessa o sistema depois de trocá-la; vencimento opcional por `PASSWORD_MAX_AGE_DAYS`.
- **Funções e permissões (RBAC por módulo)**: Enfermeiro, Técnico de Enfermagem e ADM de cada área (CCIH, CME, Qualidade), Jovem Aprendiz (só o que o gestor concede, com supervisor e validade), além de Médico infectologista, Auditor, Gestor, Consulta e Administrador do sistema; 52 permissões granulares que separam consultar, registrar, aprovar/liberar, configurar e administrar, com **escopo por setor** e autorizações individuais auditadas. Tudo verificado no servidor; ninguém altera o próprio acesso; só a **conta criadora** (criada por comando local, `npm run admin:bootstrap -w @ccih/api`) cria Administradores do sistema. Matriz em [docs/rbac/02-MATRIZ-DE-PERMISSOES.md](docs/rbac/02-MATRIZ-DE-PERMISSOES.md).
- **Pacientes** identificados por iniciais + prontuário. O nome completo é opcional, **cifrado** (AES-256-GCM) e só aparece com a permissão de dado identificado, mediante motivo, com registro no log. Página do paciente com linha do tempo longitudinal, internações e permanências por setor/leito, dispositivos com dia de uso, transferências, saída, cirurgias, culturas, casos de IRAS e **evolução CCIH** permanente (correções por retificação).
- **Censo diário**: ocupação e denominadores reais (paciente-dia e dispositivo-dia) calculados das permanências e dispositivos no horário de censo configurado.
- **Vigilância IRAS**: suspeita → investigação → confirmação/descarte, com histórico imutável, justificativa obrigatória, vínculos com dispositivo, cirurgia e culturas da mesma internação, apoio à decisão pelos parâmetros configurados (dia de internação, dia de dispositivo, elegibilidade) e critério diagnóstico congelado na decisão — marcado "Requer validação institucional" quando a referência não foi validada. O sistema nunca classifica sozinho.
- **Cirurgias**: registro com início/término, potencial de contaminação, ASA, implante, índice de risco, antibioticoprofilaxia avaliada pela janela institucional e janela de vigilância de ISC. Filtros por procedimento, cirurgião e classificação.
- **Microbiologia**: coletas, resultados **versionados** (correção = nova versão com justificativa), isolados, antibiograma e perfil MDR/XDR/PDR informado pelo laboratório/CCIH.
- **Vigilância pós-alta de ISC**: lista de cirurgias com janela de vigilância aberta (duração pelos parâmetros institucionais, com ou sem implante), contatos registrados (telefone, ambulatório, retorno, mensagem) somente por inserção; uma suspeita abre o caso de ISC na Vigilância IRAS.
- **Bundles**: modelos configuráveis (itens, método tudo ou nada / por item, referência), um modelo ativo por indicador (CVC, VM, SVD); auditoria à beira-leito com resultado calculado na hora, anulação com justificativa (nunca exclusão), adesão por setor e Pareto dos itens não conformes. **Higiene das mãos**: observações por oportunidades/ações.
- **Auditorias e não conformidades**: auditoria planejada → em andamento → concluída → plano de ação → verificação de eficácia → encerrada; não conformidade aberta → em tratamento → aguardando eficácia → encerrada, com plano de ação **5W2H**, prazos e histórico somente inserção.
- **Central de Alertas**: gerados dos registros (investigação parada, dispositivo em uso além do prazo de reavaliação, MDR novo, treinamento vencido, insumo em ruptura ou vencendo, ação atrasada, contato pós-alta pendente) com prioridade, **deduplicação** por chave, supressão configurável após o encerramento, encerramento automático quando a condição some, responsável e encerramento com o que foi feito. Cada perfil vê só os tipos do seu módulo; contador no menu.
- **Treinamentos**: catálogo com público-alvo por função, validade e obrigatoriedade; turmas com presença; cobertura por setor (válido / vencendo / vencido / pendente).
- **Insumos**: lotes com validade e movimentações em **livro-razão somente inserção** (entrada, consumo, ajuste, descarte), estoque que nunca fica negativo, cobertura em dias pelo consumo médio e alertas de ruptura/validade.
- **CME**:
  - Equipamentos (tipo, série, qualificação térmica) bloqueáveis para manutenção com motivo; catálogo de caixas (embalagem, implantável).
  - Cada carga é um ciclo: código e etiquetas dos pacotes gerados na gravação, validade da esterilização pelo parâmetro institucional, registro físico do ciclo.
  - **Bowie-Dick** diário por autoclave a vapor pré-vácuo (grade de 14 dias); **indicadores químicos** classes 1–6 e **biológico** com incubação, leitura e indicador controle; lote e validade do indicador conferidos. Leituras e correções são novas versões, e o registro anterior continua visível.
  - **Liberação**: a política institucional avalia a carga e o sistema só deixa liberar o que ela permite; reter, rejeitar, reprocessar e **recolher** (rejeitar depois de liberar) exigem motivo e confirmação. O histórico de decisões guarda a versão da política e a avaliação mostrada a quem decidiu, e não pode ser alterado.
  - **Uso e rastreabilidade**: o pacote é registrado na cirurgia pela etiqueta (só de carga liberada, dentro da validade e ainda não usado) ou no setor, sem paciente. A pesquisa vai da etiqueta, carga ou caixa até o paciente, e do prontuário até os pacotes usados; o paciente só aparece para perfis com acesso a pacientes.
  - **Etiquetas**: Code 128 gerado no próprio sistema e conferido por leitura automática antes de imprimir; layouts por tipo (pacote, ativo, recepção avulsa) com tamanho, margens, resolução e campos; impressão pelo navegador no tamanho real ou arquivo ZPL para impressora térmica; reimpressão com motivo (a anterior fica substituída) e cancelamento, tudo registrado e imutável. Sem dado de paciente na etiqueta. Validação com impressora e leitor reais: [roteiro](docs/cme-integracao/02-ROTEIRO-VALIDACAO-ETIQUETAS.md).
  - **Evidências** (folha de Bowie-Dick, impressões do ciclo, lista de presença de treinamento) em PDF, PNG ou JPEG, verificadas pelo conteúdo; antivírus ClamAV quando configurado (ameaça recusada; sem antivírus o arquivo fica sinalizado como "não verificado"), cifragem AES-256-GCM (obrigatória em produção) com conferência de integridade em toda leitura, armazenamento local ou compatível com S3. Operação: [docs/cme-integracao/03-ANEXOS-OPERACAO.md](docs/cme-integracao/03-ANEXOS-OPERACAO.md).
  - Alertas de carga recolhida com pacientes expostos, carga liberada com teste reprovado, Bowie-Dick reprovado com equipamento em uso, indicador biológico sem leitura no prazo e qualificação a vencer.
- **Consolidação de indicadores** a partir dos registros clínicos (IRAS por tipo, densidades, MDR, investigações abertas, profilaxia, ISC em cirurgia limpa) e operacionais (adesão a bundles, higiene das mãos, consumo de preparação alcoólica, cobertura de treinamento) e da CME (ciclos, Bowie-Dick, indicadores químicos e biológicos, cargas liberadas, retidas e reprocessadas, caixas rastreadas até o paciente), auditada; indicadores sem regra configurada não são calculados.
- **Unidades, setores e leitos** cadastráveis em Administração.
- **Visão Geral** executiva com KPIs de IRAS, exposição, tendências, IRAS por setor, bundles, CME, antimicrobianos e treinamentos — calculados por um único motor de indicadores; filtros de período, unidade e setor.
- **Catálogo de indicadores** (31) com fórmula, unidade, direção, fonte, responsável e meta com origem.
- **Administração**:
  - Metas: de demonstração para institucionais, com aprovador, data e referência.
  - Parâmetros de regras (janela de profilaxia, vigilância de ISC, associação a dispositivo…), cada um ligado a uma referência.
  - Referências clínicas/regulatórias com versão, fonte, data, validador e status (vigente / revisão necessária / arquivado); editar o conteúdo invalida a validação.
  - Política de liberação de cargas da CME.
  - Gestão de usuários: cadastro completo, função no sistema, setor, situação (pendente, ativa, suspensa, desativada), autorizações individuais e histórico de alterações (toda alteração encerra as sessões do usuário).
  - Log de auditoria com antes/depois, justificativa, filtros e verificação de integridade.
- **Toda alteração exige justificativa**, confirmação explícita, controle de concorrência (versão do registro) e fica no log de auditoria na mesma transação.
- Tema claro/escuro, responsivo (1920 → 390 px), navegação por teclado, gráficos com tabela alternativa.

## Requisitos

- Node.js ≥ 22 e npm ≥ 10
- PostgreSQL 16

## Instalação

```bash
npm ci
```

### Banco de dados

O sistema usa dois papéis: um **dono** (roda migrações) e um **papel de aplicação** com privilégio mínimo (sem DDL, sem UPDATE/DELETE no log de auditoria).

Nenhuma senha aparece nesta documentação nem deve ser digitada na linha de comando (ficaria no histórico do shell). Crie os papéis e defina as senhas pelo prompt oculto do `psql`:

```sql
-- psql como superusuário do PostgreSQL
CREATE ROLE ccih_owner LOGIN;
CREATE ROLE ccih_app   LOGIN;
\password ccih_owner
\password ccih_app
CREATE DATABASE ccih_dev  OWNER ccih_owner;
CREATE DATABASE ccih_test OWNER ccih_owner;
REVOKE ALL ON DATABASE ccih_dev, ccih_test FROM PUBLIC;
GRANT CONNECT ON DATABASE ccih_dev, ccih_test TO ccih_app;
```

`\password` pede a senha sem exibi-la e a envia já criptografada (SCRAM) ao servidor.

```bash
cp apps/api/.env.example apps/api/.env && chmod 600 apps/api/.env   # edite as URLs no editor, não no terminal
npm run db:reset -w @ccih/api                                       # migrações + dados sintéticos de demonstração
```

O seed cria um usuário sintético por perfil (`admin`, `enf.ccih`, `infecto`, `cme`, `auditor`, `gestor`, `consulta`) com **senhas aleatórias**. Elas não são exibidas no terminal: ficam somente em `apps/api/.seed-credentials.local` (permissão 600, ignorado pelo git). Repasse cada senha só ao seu usuário e apague o arquivo depois; não cole senhas em chats, tickets ou documentação. Testes automatizados geram uma senha aleatória a cada execução.

| Comando (`-w @ccih/api`) | O que faz |
| --- | --- |
| `npm run db:migrate` | Aplica migrações pendentes e os privilégios do papel de aplicação |
| `npm run db:seed` | Cria o ambiente de demonstração (recusa se já houver instituição) |
| `npm run db:reset` | Recria o schema do zero + seed (proibido em produção) |
| `npm run audit:verify` | Recalcula a cadeia de hashes do log de auditoria |

## Execução

```bash
npm run dev -w @ccih/api                                    # API em http://127.0.0.1:3001
cp .env.example apps/web/.env.local                         # VITE_DATA_SOURCE=api
npm run dev                                                 # web em http://localhost:5173 (proxy /api)
```

Sem backend, `VITE_DATA_SOURCE=demo` abre a interface com dados sintéticos gerados no navegador, **somente leitura** e sem login.

## Testes e qualidade

| Comando | O que faz |
| --- | --- |
| `npm run lint` | ESLint (TypeScript, hooks, acessibilidade JSX), zero avisos |
| `npm run typecheck` | `tsc` estrito em todos os pacotes |
| `npm test` | Vitest: domínio (67), dados sintéticos (13), componentes (14), web (35), API com PostgreSQL real (71) |
| `npm run build` | Verifica tokens, gera `apps/web/dist` e `apps/api/dist` |
| `npm run check` | Tudo acima |
| `npm run e2e` | Playwright (Chromium) contra API + banco + web reais: fluxo completo de IRAS, bloqueios por perfil, alerta assumido e encerrado, auditoria → não conformidade → 5W2H, troca obrigatória da senha temporária e CME (carga → ciclo → indicador → liberação → uso na cirurgia → rastreio até o paciente) |

O E2E reaproveita os servidores de desenvolvimento se estiverem rodando (API :3001, web :5173); senão sobe a API compilada e o `vite preview` (gere antes o build com `VITE_DATA_SOURCE=api`). Ele precisa do banco com o seed sintético e lê as senhas de `E2E_PASSWORD` ou do arquivo local do seed — nenhuma senha fica no código.

Os testes da API recriam o banco `ccih_test` a cada execução (`TEST_DATABASE_URL`, `TEST_DATABASE_OWNER_URL`). A CI (`.github/workflows/ci.yml`) sobe um PostgreSQL 16 efêmero, acessível só dentro do job e sem senha versionada, e roda `npm audit`, lint, typecheck, testes e build; um segundo job gera uma senha aleatória mascarada, recria o banco de demonstração e roda o E2E.

## Variáveis de ambiente

- **Web** (`apps/web/.env.local`): `VITE_DATA_SOURCE` = `api` ou `demo`. Obrigatória em build de produção. Nenhum segredo vai para o front-end.
- **API** (`apps/api/.env`): veja [apps/api/.env.example](apps/api/.env.example) — URLs do banco, `APP_ORIGIN`, tempos de sessão, bloqueio, limite de login, `COOKIE_SECURE`, `TRUST_PROXY`, `PASSWORD_MAX_AGE_DAYS` (0 = sem vencimento), `UPLOAD_DIR` e `UPLOAD_MAX_MB` (anexos, fora da raiz web) e, opcionalmente, `FIELD_ENCRYPTION_KEY` (32 bytes em base64, gerada localmente) para permitir o nome completo cifrado de pacientes; sem ela o sistema trabalha só com iniciais e prontuário. A API não inicia com configuração inválida, e exige `COOKIE_SECURE=true` em produção.

## Build e deploy

```bash
VITE_DATA_SOURCE=api npm run build
```

- **Web**: arquivos estáticos em `apps/web/dist`, servidos com fallback de SPA para `index.html` e cabeçalhos de segurança (CSP, HSTS) no proxy.
- **API**: `apps/api/dist/server.js` (pacotes internos embutidos). Em produção: `npm ci --omit=dev`, `NODE_ENV=production`, `npm run db:migrate -w @ccih/api` com o papel dono e `node dist/server.js` com o papel de aplicação.
- Mesma origem para web e `/api` (proxy reverso com TLS), `TRUST_PROXY=true` atrás do proxy, backups cifrados do PostgreSQL com teste de restauração e `audit:verify` agendado.
- Um ambiente de demonstração mantém a faixa "Ambiente de demonstração" visível; o seed recusa rodar com `NODE_ENV=production`.

## Documentação

- [ARCHITECTURE.md](ARCHITECTURE.md) — camadas, fontes de dados, motor de indicadores, API
- [DATA_MODEL.md](DATA_MODEL.md) — modelo relacional (implementado e planejado)
- [SECURITY.md](SECURITY.md) — segurança e LGPD
- [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) — tokens e componentes
- [CONTRIBUTING.md](CONTRIBUTING.md) — regras do projeto e testes
- [docs/auditoria/](docs/auditoria/) — auditorias técnicas (Fase 1, reauditoria 1.1, Fases 2 a 5)
- [docs/ROADMAP.md](docs/ROADMAP.md) — fases, dependências e riscos
- `ccih-integra/` — design system publicado (guia de marca, conteúdo técnico, tokens)

## Aviso clínico

Critérios, metas, parâmetros e durações de referência (P75) carregados pelo seed são **de demonstração e exigem validação institucional**. O sistema apoia a decisão da CCIH; não a substitui.
