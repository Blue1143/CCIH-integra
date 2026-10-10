# Matriz de permissões — referência para manutenção

Gerada a partir de `packages/domain/src/permissions.ts` (fonte única: a API, a interface e os testes usam as mesmas definições). Ao alterar a matriz, altere o domínio, crie uma migração que atualize os perfis existentes e regenere esta tabela.

Legenda: ● concedida pela função · ○ pode ser concedida individualmente (autorização expressa, com justificativa e validade) · — não.
Colunas: Enf. CCIH = Enfermeiro CCIH; Enf. CME = Enfermeiro CME; Enf. Qual. = Enfermeiro Qualidade; Téc. CCIH = Técnico de Enfermagem CCIH; Téc. CME = Técnico de Enfermagem CME; Téc. Qual. = Técnico de Enfermagem Qualidade; ADM CME = ADM CME; ADM CCIH = ADM CCIH; Aprendiz = Jovem Aprendiz; Infecto. = Médico infectologista; Auditor = Auditor; Gestor = Gestor; Consulta = Consulta.

Administrador do sistema: todas as permissões, exceto criar/alterar Administradores do sistema e a conta criadora. **Administrador criador**: todas, inclusive criar Administradores do sistema.

| Permissão | Descrição | Enf. CCIH | Enf. CME | Enf. Qual. | Téc. CCIH | Téc. CME | Téc. Qual. | ADM CME | ADM CCIH | Aprendiz | Infecto. | Auditor | Gestor | Consulta |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `dashboard:view` | Ver painel executivo | ● | — | ● | ● | — | ● | — | ● | ○ | ● | ● | ● | ● |
| `indicators:view` | Ver catálogo e valores de indicadores | ● | — | ● | ● | — | ● | — | ● | ○ | ● | ● | ● | ● |
| `indicators:consolidate` | Consolidar indicadores a partir dos registros clínicos | ● | — | — | — | — | — | — | ● | — | — | — | — | — |
| `reports:view` | Ver e gerar relatórios | ● | ● | ● | ● | ○ | ● | ● | ● | ○ | ● | ● | ● | — |
| `config:view` | Ver configurações, referências e parâmetros | ● | — | ● | — | — | — | ● | ● | — | ● | ● | — | — |
| `config:targets:edit` | Editar metas de indicadores | — | — | — | — | — | — | — | ● | — | — | — | — | — |
| `config:rules:edit` | Editar parâmetros de regras institucionais (todos os módulos) | — | — | — | — | — | — | — | — | — | — | — | — | — |
| `config:references:edit` | Cadastrar e editar referências clínicas e regulatórias | — | — | — | — | — | — | — | ● | — | — | — | — | — |
| `config:references:validate` | Validar referências clínicas e regulatórias | ● | — | — | — | — | — | — | ● | — | ● | — | — | — |
| `config:org:edit` | Editar instituição, unidades e setores | — | — | — | — | — | — | — | — | — | — | — | — | — |
| `config:cme_policy:edit` | Editar a política de liberação de cargas da CME | — | — | — | — | — | — | ● | — | — | — | — | — | — |
| `ccih:parameters:edit` | Editar parâmetros institucionais da CCIH (dispositivos, internação, cirurgia, antimicrobianos, alertas) | — | — | — | — | — | — | — | ● | — | — | — | — | — |
| `cme:parameters:edit` | Editar parâmetros institucionais da CME | — | — | — | — | — | — | ● | — | — | — | — | — | — |
| `users:view` | Ver usuários e perfis | — | — | — | — | — | — | — | — | — | — | ● | — | — |
| `users:manage` | Gerenciar usuários, perfis e escopos (todos os módulos) | — | — | — | — | — | — | — | — | — | — | — | — | — |
| `users:manage:ccih` | Gerenciar usuários e funções da CCIH | — | — | — | — | — | — | — | ● | — | — | — | — | — |
| `users:manage:cme` | Gerenciar usuários e funções da CME | — | — | — | — | — | — | ● | — | — | — | — | — | — |
| `audit:view` | Consultar o log de auditoria completo | — | — | — | — | — | — | — | — | — | — | ● | — | — |
| `audit:view:module` | Consultar o log de auditoria do próprio módulo | — | — | — | — | — | — | ● | ● | — | — | — | — | — |
| `patient:view` | Ver pacientes (iniciais e prontuário) | ● | — | — | ● | — | — | — | ● | ○ | ● | ● | — | — |
| `patient:view_identified` | Ver dados identificados de pacientes | ● | — | — | — | — | — | — | ● | — | ● | — | — | — |
| `patient:edit` | Registrar pacientes, internações, movimentações, dispositivos e evoluções CCIH | ● | — | — | ● | — | — | — | ● | — | — | — | — | — |
| `iras:view` | Ver vigilância de IRAS | ● | — | — | ● | — | — | — | ● | ○ | ● | ● | — | — |
| `iras:edit` | Registrar suspeitas e investigações de IRAS | ● | — | — | ● | — | — | — | ● | — | ● | — | — | — |
| `iras:decide` | Confirmar ou descartar IRAS | ● | — | — | — | — | — | — | ● | — | ● | — | — | — |
| `surgery:view` | Ver registro cirúrgico | ● | — | — | ● | — | — | — | ● | ○ | ● | ● | — | — |
| `surgery:edit` | Registrar cirurgias e antibioticoprofilaxia | ● | — | — | — | — | — | — | ● | — | — | — | — | — |
| `micro:view` | Ver microbiologia | ● | — | — | ● | — | — | — | ● | ○ | ● | ● | — | — |
| `micro:edit` | Registrar culturas e perfis microbiológicos | — | — | — | — | — | — | — | — | — | ● | — | — | — |
| `atm:view` | Ver antimicrobianos | ● | — | — | ● | — | — | — | ● | ○ | ● | ● | — | — |
| `atm:review` | Registrar revisão de antimicrobianos | — | — | — | — | — | — | — | — | — | ● | — | — | — |
| `cme:view` | Ver CME e rastreabilidade (somente leitura) | ● | ● | — | ● | ● | — | ● | ● | ○ | — | ● | — | — |
| `cme:scan` | Registrar leituras nas estações da CME (entrada, processamento e saída) | — | ● | — | — | ● | — | ● | — | ○ | — | — | — | — |
| `cme:cycle:record` | Montar cargas, registrar ciclos e usos de material da CME | — | ● | — | — | ● | — | ● | — | — | — | — | — | — |
| `cme:test:record` | Registrar testes físicos, químicos, biológicos e Bowie-Dick | — | ● | — | — | ● | — | ● | — | — | — | — | — | — |
| `cme:release` | Liberar, reter ou rejeitar cargas | — | ● | — | — | ○ | — | ● | — | — | — | — | — | — |
| `cme:configure` | Cadastrar equipamentos da CME e o catálogo de caixas | — | ● | — | — | — | — | ● | — | — | — | — | — | — |
| `cme:stations:configure` | Cadastrar e parear estações de leitura e configurar o fluxo da CME | — | ● | — | — | — | — | ● | — | — | — | — | — | — |
| `cme:override` | Autorizar exceção de sequência no fluxo da CME (com justificativa) | — | ● | — | — | ○ | — | ● | — | — | — | — | — | — |
| `quality:view` | Ver bundles, auditorias, treinamentos e insumos | ● | — | ● | ● | — | ● | — | ● | ○ | — | ● | ● | — |
| `quality:bundle:record` | Registrar auditorias de bundle e observações de higiene das mãos | ● | — | ● | ○ | — | ● | — | ● | ○ | — | — | — | — |
| `quality:audit:execute` | Registrar achados, evidências e andamento de ações de auditorias | ○ | — | ● | ○ | — | ● | — | — | ○ | — | — | — | — |
| `quality:audit:manage` | Planejar, conduzir e concluir auditorias; tratar e encerrar não conformidades | — | — | ● | — | — | — | — | — | — | — | — | — | — |
| `quality:training:edit` | Registrar treinamentos e presenças | ● | — | ● | — | — | — | ● | ● | — | — | — | — | — |
| `quality:supplies:edit` | Registrar insumos e movimentações de estoque | ● | — | ● | — | — | — | — | ● | — | — | — | — | — |
| `quality:configure` | Configurar modelos de bundle, catálogo de treinamentos e de insumos | — | — | — | — | — | — | — | ● | — | — | — | — | — |
| `nc:record` | Registrar não conformidades (sem tratá-las ou encerrá-las) | ● | ● | ● | ● | ● | ● | ● | ● | ○ | ● | — | — | — |
| `alerts:view` | Ver alertas | ● | ● | ● | ● | ● | ● | ● | ● | ○ | ● | ● | — | — |
| `alerts:manage` | Reconhecer, assumir, resolver e encerrar alertas | ● | ● | ● | — | — | — | ● | ● | — | ● | — | — | — |
| `alerts:exception` | Encerrar por exceção formal um alerta bloqueante cuja condição persiste | ● | — | — | — | — | — | — | ● | — | — | — | — | — |
| `export:aggregate` | Exportar dados agregados | ● | — | ● | ○ | — | — | — | ● | ○ | ● | — | ● | — |
| `export:identified` | Exportar dados identificáveis | — | — | — | — | — | — | — | — | — | — | — | — | — |

## Quem pode atribuir o quê

| Gestor | Funções que atribui | Contas que altera | Concessões individuais |
| --- | --- | --- | --- |
| Administrador criador | todas, inclusive Administrador do sistema | todas, exceto a própria (a sua senha é trocada em "Minha conta") | todas, exceto as nunca delegáveis |
| Administrador do sistema | todas, exceto Administrador do sistema | todas, exceto Administradores e a conta criadora | todas, exceto as nunca delegáveis |
| ADM CME | Enfermeiro CME, Técnico CME, Jovem Aprendiz | só contas cujas funções são todas da CME (nunca outro ADM) | `cme:view`, `cme:scan`, `cme:cycle:record`, `cme:test:record`, `cme:release`, `cme:override`, `nc:record`, `alerts:view`, `reports:view` |
| ADM CCIH | Enfermeiro CCIH, Técnico CCIH, Jovem Aprendiz | só contas cujas funções são todas da CCIH (nunca outro ADM) | `dashboard:view`, `indicators:view`, `reports:view`, `patient:view`, `iras:view`, `iras:edit`, `surgery:view`, `micro:view`, `atm:view`, `cme:view`, `quality:view`, `quality:bundle:record`, `quality:audit:execute`, `nc:record`, `alerts:view`, `export:aggregate` |

Nunca concedidas individualmente: `users:view`, `users:manage`, `users:manage:ccih`, `users:manage:cme`, `audit:view`, `audit:view:module`, `config:targets:edit`, `config:rules:edit`, `config:references:edit`, `config:org:edit`, `config:cme_policy:edit`, `ccih:parameters:edit`, `cme:parameters:edit`, `patient:view_identified`, `export:identified`, `alerts:exception`, `quality:configure`.

Ninguém altera o próprio acesso (função, permissões, setor ou situação). Toda alteração exige justificativa, registra quem autorizou, encerra as sessões do usuário e fica no histórico (função anterior e nova, permissões anteriores e novas).

## Jovem Aprendiz

Começa sem permissões e **pendente**; só entra no sistema depois que o gestor define pacotes ou permissões (somente da lista permitida), setor, supervisor e data de expiração/revisão. Fora da validade o acesso é negado e as sessões são encerradas.

| Pacote | Módulo | Permissões |
| --- | --- | --- |
| Consulta CCIH | ccih | `dashboard:view`, `indicators:view`, `iras:view`, `patient:view`, `surgery:view`, `micro:view`, `alerts:view` |
| Apoio operacional CCIH | ccih | `dashboard:view`, `indicators:view`, `iras:view`, `patient:view`, `quality:view`, `quality:bundle:record`, `nc:record`, `alerts:view` |
| Consulta CME | cme | `cme:view` |
| Registro operacional CME | cme | `cme:view`, `cme:scan`, `nc:record` |
| Consulta Qualidade | qualidade | `quality:view`, `indicators:view` |
| Apoio em auditorias | qualidade | `quality:view`, `quality:audit:execute`, `nc:record` |
| Consulta de indicadores | qualidade | `dashboard:view`, `indicators:view` |

## Conta criadora (instalação)

A conta criadora é única por instituição e só é criada no servidor, por quem instala o sistema:

```
npm run admin:bootstrap -w @ccih/api -- --login <login> --nome "<nome completo>"
```

A senha é digitada sem eco no terminal (em automação, a variável `BOOTSTRAP_ADMIN_PASSWORD`, apenas para aquela execução — nunca em arquivo). Nenhuma credencial fica no código, no seed, no `.env.example` ou na documentação. Uma senha fora da política (mínimo de 12 caracteres e três tipos de caractere) é aceita só como inicial: o primeiro acesso exige a troca antes de qualquer outra ação. O comando recusa criar uma segunda conta criadora, e o banco impede retirar a condição de criadora ou o perfil de administrador dessa conta.

Depois, dentro do sistema, em **Administração → Gestão de usuários → Criar administrador do sistema** (visível só para a conta criadora), ela cria os demais administradores.

## Onde a regra é verificada

- **API (barreira real):** cada rota exige permissão (`requirePermission`); a gestão de usuários aplica as regras de módulo, criador e autoelevação; negações são registradas no log de auditoria (`access_denied`).
- **Sessão:** carrega perfis + concessões válidas a cada requisição; conta pendente, suspensa, desativada ou fora da validade não autentica.
- **Banco:** gatilhos protegem a conta criadora; concessões removidas são revogadas (não apagadas); histórico e log são somente inserção.
- **Interface:** menus, rotas e botões refletem as mesmas permissões (nunca são a proteção).
- **Testes:** `packages/domain/src/rbac.test.ts`, `apps/api/test/rbac.test.ts` (14 cenários por chamada direta à API), `apps/web/src/features/admin/users.test.tsx`, `e2e/rbac.spec.ts`.
