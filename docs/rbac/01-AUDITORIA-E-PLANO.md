# Usuários, funções e permissões — auditoria do repositório e plano de implementação

Data: 10/10/2026. Escopo: cadastro de usuários, funções profissionais, permissões por módulo, segregação de responsabilidades e controle de operações no CCIH Integra. Nenhuma migração foi feita antes deste plano.

## 1. O que já existe (aproveitado, não reconstruído)

| Área | Situação atual | Onde |
| --- | --- | --- |
| Autenticação | Login local, senha com hash argon2id, bloqueio por tentativas, limite por IP, troca obrigatória de senha temporária, validade opcional de senha | `apps/api/src/routes/auth.ts`, `security/crypto.ts` |
| Sessão | Cookie `HttpOnly`/`SameSite=Strict`, token só em hash no banco, CSRF, expiração por inatividade e tempo máximo, revogação | `http/auth.ts` (`sessionLoader`) |
| RBAC | Permissões granulares (`PERMISSIONS`, 47 chaves), perfis (`role`) com lista de permissões no banco, `user_role`, escopo por setor (`user_scope`), **verificação no servidor em todas as rotas** (`requirePermission`), negação registrada no log | `packages/domain/src/permissions.ts`, rotas |
| Escopo de dados | Filtro por instituição e setor do usuário nas consultas clínicas, alertas, tempo real | repositórios e rotas |
| Gestão de usuários | Criar (senha temporária), alterar perfis/escopo/ativo com justificativa, redefinir senha, desbloquear; alteração encerra as sessões do usuário; ninguém remove o próprio acesso de administrador | `routes/admin.ts`, `UsersPage.tsx` |
| Auditoria | Log encadeado por hash, imutável no banco; acessos negados, exportações e alterações de acesso registrados | `audit/audit.ts` |
| Interface | Menu e rotas filtrados por permissão (`Guard`), botões ocultos sem permissão — mas a API é a barreira real | `app/routes.tsx`, `navigation.ts` |

Perfis atuais: Administrador, Enfermeiro CCIH, Médico infectologista, CME, Auditor, Gestor, Consulta.

## 2. Lacunas e riscos encontrados

1. **Funções pedidas não existem.** Não há Enfermeiro/Técnico CME, Enfermeiro/Técnico Qualidade, Técnico CCIH, ADM CME, ADM CCIH nem Jovem Aprendiz. O perfil "CME" atual junta execução, liberação e configuração.
2. **Permissões largas demais para separar execução de aprovação.** `cme:edit` cobre cargas, ciclos e testes; `quality:edit` cobre auditorias, bundles, higiene das mãos, treinamentos e insumos. Não é possível dar ao técnico "registrar" sem também "conduzir/encerrar".
3. **Administração só global.** `users:manage` e `config:rules:edit` valem para tudo: não existe administrador de módulo que gerencie só a CME ou só a CCIH, nem bloqueio de concessão fora da própria área.
4. **Sem administrador criador.** Qualquer Administrador cria outro Administrador; não há conta raiz protegida.
5. **Autoelevação parcial.** O servidor impede remover o próprio acesso de administrador e desativar a própria conta, mas um usuário com `users:manage` pode alterar os próprios perfis (acrescentar). Precisa ser proibido para todos.
6. **Cadastro incompleto.** Faltam e-mail institucional, categoria profissional, função, situação (pendente/ativo/suspenso/desativado), quem autorizou, data da última alteração de permissões, validade e supervisor (aprendiz).
7. **Sem permissões individuais.** Não há concessão pontual por usuário (necessária para o Jovem Aprendiz e para "autorização institucional expressa", p. ex. liberação por técnico).
8. **Log por módulo.** `audit:view` mostra o log inteiro; ADM CME/CCIH precisam ver só o do seu módulo.
9. Exportação identificável (`export:identified`) existe no catálogo, mas não há rota que a use — sem risco hoje.

## 3. Modelo proposto

### 3.1 Princípios

- Negação por padrão; a API verifica toda permissão (a interface só reflete). Nenhuma decisão por nome de perfil (`role === 'cme'`): só por permissão.
- **Permissões continuam com o padrão atual `modulo:acao`**, com as permissões largas divididas. As chaves sugeridas no pedido (`cme.load.release` etc.) estão mapeadas na matriz do §4; renomear as 47 existentes não acrescenta segurança e arriscaria regressões.
- Ações distintas: consultar (`view`), registrar/executar (`record`, `scan`, `execute`), aprovar/liberar (`release`, `manage`, `decide`), configurar (`configure`, `parameters`), administrar (`users:manage:<módulo>`).
- Administração de módulo não dá acesso a outro módulo, nem a usuários de outro módulo.
- Ninguém altera as próprias funções, permissões, escopo ou situação.

### 3.2 Divisão das permissões largas

| Atual | Passa a ser |
| --- | --- |
| `cme:edit` | `cme:cycle:record` (montar carga, iniciar/encerrar ciclo, registrar uso avulso) · `cme:test:record` (testes físicos, químicos, biológicos e Bowie-Dick) |
| `quality:edit` | `quality:audit:manage` (planejar, conduzir, concluir auditorias; tratar e encerrar NC; planos 5W2H) · `quality:audit:execute` (registrar achados, evidências e andamento de ações) · `quality:bundle:record` (bundles e higiene das mãos) · `quality:training:edit` · `quality:supplies:edit` |
| — (novo) | `nc:record` — registrar não conformidade (CCIH, CME, Qualidade) sem poder tratá-la/encerrá-la |
| `config:rules:edit` (global) | mantido para o Administrador; novos `cme:parameters:edit` (parâmetros do grupo CME e política de liberação) e `ccih:parameters:edit` (demais grupos) |
| `audit:view` (global) | mantido; novo `audit:view:module` (só eventos das entidades do(s) módulo(s) do usuário) |
| `users:manage` (global) | mantido para o Administrador; novos `users:manage:cme` e `users:manage:ccih` (só usuários e funções do próprio módulo) |

### 3.3 Conta criadora e Administradores do sistema

- **Administrador criador**: marcação `is_founder` única por instituição, protegida no banco. Tem todas as permissões e é o **único** que pode criar, alterar ou desativar um Administrador do sistema. Não pode ser desativado nem rebaixado por ninguém.
- **Administrador do sistema**: todas as permissões, exceto criar/alterar Administradores do sistema e alterar a conta criadora.
- A conta criadora é criada por um **comando local** (`npm run admin:bootstrap -w @ccih/api`) executado por quem tem acesso ao servidor. Login e senha são informados na hora (a senha é lida sem eco no terminal); **nada fica no código, no seed, no `.env.example` nem na documentação**. O comando recusa rodar se já existir uma conta criadora.
- A senha informada no pedido **não atende à política de senha do sistema** (mínimo de 12 caracteres e 3 tipos de caractere) e foi exposta na conversa. Proposta: aceitá-la apenas como **senha inicial temporária**, com troca obrigatória no primeiro acesso (a sessão só permite trocar a senha até isso acontecer). A política não será enfraquecida.
- Em "Administração → Usuários", a opção **"Criar administrador do sistema"** aparece só para a conta criadora; a API recusa (403, registrado no log) para qualquer outra conta, mesmo por requisição manual.

### 3.4 Funções (perfis) e módulo de cada uma

| Função | Módulo | Quem pode atribuir |
| --- | --- | --- |
| Enfermeiro CCIH, Técnico de Enfermagem CCIH | CCIH | Administrador, ADM CCIH |
| Enfermeiro CME, Técnico de Enfermagem CME | CME | Administrador, ADM CME |
| Enfermeiro Qualidade, Técnico de Enfermagem Qualidade | Qualidade | Administrador |
| ADM CCIH, ADM CME | CCIH / CME | Administrador |
| Jovem Aprendiz | conforme o gestor | Administrador; ADM do módulo (só concessões do próprio módulo) |
| Administrador do sistema | Sistema | **só o Administrador criador** |

Um ADM de módulo não cria outro ADM (evita escalada lateral) e só altera usuários cujas funções são todas do seu módulo.

### 3.5 Jovem Aprendiz

- Conta nasce **pendente** e não entra no sistema até o gestor definir as permissões.
- O gestor escolhe um ou mais pacotes (Consulta CCIH, Apoio operacional CCIH, Consulta CME, Registro operacional CME, Consulta Qualidade, Apoio em auditorias, Consulta de indicadores) e pode ajustar permissões individuais **dentro de uma lista permitida** (sem administração, sem liberação de carga, sem decisão de IRAS, sem dados identificados de pacientes, sem configuração, sem gestão de usuários). Também define o setor, a data de início, a data de expiração/revisão e o supervisor. Exportação só agregada e só se marcada.
- Fora da janela de datas, o acesso é negado e as sessões são encerradas.

### 3.6 Concessões individuais (autorização expressa)

Tabela `user_permission` (permissão, quem concedeu, justificativa, validade). Usada para o Jovem Aprendiz e para autorizações institucionais pontuais, p. ex. **liberação de carga por um técnico de CME**, que só o Administrador ou o ADM CME podem conceder, com justificativa e validade. Cada módulo tem a sua lista de permissões delegáveis; administração e gestão de usuários nunca são delegáveis.

### 3.7 Cadastro (migração 0009)

`app_user` ganha: e-mail institucional, categoria profissional, função, situação (`pendente`, `ativo`, `suspenso`, `desativado`), criado por, autorizado por, data da última alteração de permissões, início e fim de validade, supervisor, `is_founder`. O identificador profissional usa `professional.registration` (já existe). `role` ganha `module`. Desativar mantém o usuário e todo o histórico (nada é apagado). Qualquer mudança de função, permissão, escopo ou situação encerra as sessões do usuário (já existe; será estendido a concessões individuais e expiração).

## 4. Matriz inicial de permissões

Legenda: ● concedida pela função · ○ delegável (concessão individual com justificativa) · — não.

| Permissão | Enf. CCIH | Téc. CCIH | Enf. CME | Téc. CME | Enf. Qual. | Téc. Qual. | ADM CME | ADM CCIH | Aprendiz |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `dashboard:view` (painel geral) | ● | ● | — | — | ● | ● | — | ● | ○ |
| `indicators:view` | ● | ● | — | — | ● | ● | — | ● | ○ |
| `reports:view` | ● | ● | ● | — | ● | ● | ● | ● | — |
| `patient:view` (iniciais e prontuário) | ● | ● | — | — | — | — | — | ● | ○ |
| `patient:view_identified` | ● | — | — | — | — | — | — | ● | — |
| `patient:edit` (internações, dispositivos, evoluções CCIH) | ● | ● | — | — | — | — | — | ● | — |
| `iras:view` / `iras:edit` | ● / ● | ● / ● | — | — | — | — | — | ● / ● | ○ / — |
| `iras:decide` (confirmar/descartar IRAS) | ● | — | — | — | — | — | — | ● | — |
| `surgery:view` / `surgery:edit` | ● / ● | ● / — | — | — | — | — | — | ● / ● | ○ / — |
| `micro:view` · `atm:view` | ● | ● | — | — | — | — | — | ● | ○ |
| `quality:view` | ● | ● | — | — | ● | ● | — | ● | ○ |
| `quality:bundle:record` | (decisão §6) | ○ | — | — | ● | ● | — | ● | ○ |
| `quality:audit:execute` | — | ○ | — | — | ● | ● | — | — | ○ |
| `quality:audit:manage` | — | — | — | — | ● | — | — | — | — |
| `quality:training:edit` | (decisão §6) | — | ○ | — | ● | — | ● | ● | — |
| `quality:supplies:edit` | (decisão §6) | — | — | — | ● | — | — | ● | — |
| `quality:configure` (modelos de bundle/checklists) | — | — | — | — | — | — | — | ● | — |
| `nc:record` | ● | ● | ● | ● | ● | ● | ● | ● | ○ |
| `cme:view` (painel e rastreabilidade, leitura) | ● | ● | ● | ● | (decisão §6) | — | ● | ● | ○ |
| `cme:scan` (registrar etapas) | — | — | ● | ● | — | — | ● | — | ○ |
| `cme:cycle:record` | — | — | ● | ● | — | — | ● | — | — |
| `cme:test:record` | — | — | ● | ● | — | — | ● | — | — |
| `cme:release` (liberar/reter/rejeitar) | — | — | ● | ○ | — | — | ● | — | — |
| `cme:override` (exceção de sequência) | — | — | ● | — | — | — | ● | — | — |
| `cme:configure` (equipamentos, caixas) | — | — | ● | — | — | — | ● | — | — |
| `cme:stations:configure` | — | — | ● | — | — | — | ● | — | — |
| `cme:parameters:edit` (parâmetros CME, política de liberação) | — | — | — | — | — | — | ● | — | — |
| `ccih:parameters:edit` (parâmetros CCIH) | — | — | — | — | — | — | — | ● | — |
| `config:targets:edit` (metas de indicadores) | — | — | — | — | — | — | — | ● | — |
| `config:references:edit` / `validate` | — | — | — | — | — | — | — | ● | — |
| `config:view` | ● | — | ● | — | ● | — | ● | ● | — |
| `alerts:view` | ● | ● | ● | ● | ● | ● | ● | ● | ○ |
| `alerts:manage` | ● | — | ● | — | ● | — | ● | ● | — |
| `alerts:exception` | — | — | — | — | — | — | — | ● | — |
| `export:aggregate` | ● | — | — | — | ● | — | ● | ● | ○ |
| `users:manage:cme` / `audit:view:module` (CME) | — | — | — | — | — | — | ● | — | — |
| `users:manage:ccih` / `audit:view:module` (CCIH) | — | — | — | — | — | — | — | ● | — |
| `users:view` | — | — | — | — | — | — | ● | ● | — |

Administrador do sistema: todas, exceto criar/alterar Administradores e a conta criadora. Administrador criador: todas.

A liberação de carga continua submetida à política validada (§ Fase 5): nenhuma permissão contorna os requisitos.

## 5. Testes (todos automatizados, contra PostgreSQL real quando envolvem a API)

Para cada função, testes positivos e **negativos por chamada direta à API**, cobrindo os 14 cenários pedidos: CCIH (enfermeiro e técnico) consulta CME sem alterar; CME executa sem acessar CCIH; técnico CME registra mas não libera sem concessão; Qualidade audita sem editar CME/registros de origem; ADM CME sem poderes de ADM CCIH e vice-versa; aprendiz só com o concedido e só dentro da validade; endpoints sem permissão; revogação encerrando sessões; negação registrada no log; ninguém altera o próprio acesso; só a conta criadora cria Administradores; operações críticas respeitando aprovação. Mais testes de interface (menus e ações por função) e E2E por perfil.

## 6. Decisões necessárias antes da Fase 2

1. **Perfis atuais fora da lista** (Médico infectologista, Auditor, Gestor, Consulta): manter como perfis adicionais ou retirar e migrar usuários.
2. **Enfermeiro CCIH e registros operacionais** de bundles, higiene das mãos, treinamentos e insumos: o pedido diz "visualizar bundles/auditorias/treinamentos" e também "gerenciar informações operacionais da CCIH".
3. **Leitura de outras áreas pela Qualidade** para auditorias: leitura fixa da CME/vigilância na função, ou só por concessão individual quando a auditoria exigir.
4. **Senha da conta criadora**: senha inicial temporária com troca obrigatória (proposto), ou definir já uma senha forte ao rodar o comando.

## 7. Ordem de execução

| Etapa | Entrega |
| --- | --- |
| R1 | Domínio: catálogo dividido, módulos, funções, matriz, listas delegáveis e do aprendiz, regras de concessão (quem pode atribuir o quê), com testes |
| R2 | Migração 0009 (cadastro, situação, conta criadora, concessões individuais, módulo dos perfis, novas permissões e migração dos perfis/usuários atuais); API: rotas trocam as permissões largas pelas divididas; gestão de usuários por módulo; comando `admin:bootstrap`; log por módulo; testes dos 14 cenários |
| R3 | Interface: Gestão de Usuários (cadastro completo, função obrigatória, seção do aprendiz, filtros, histórico), "Criar administrador do sistema" só para a conta criadora, menus e ações por permissão, CME somente leitura com aviso contextual |
| R4 | Validação completa (lint, tipos, testes, build, E2E por perfil e de acesso indevido) e matriz de permissões para manutenção |

O plano da CME (F1 em diante) fica pausado até R4.
