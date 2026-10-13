# Complemento CME + CCIH — Diagnóstico do repositório e plano de execução

Data: 09/10/2026 · Base: commit `274596e` (Fases 1–5) · Situação: **Fases A (diagnóstico) e B (projeto técnico)**. Nenhuma migração foi criada ou executada nesta etapa.

Legenda: **Existe** = implementado e testado · **Parcial** = existe base reaproveitável, falta parte do requisito · **Falta** = não há implementação.

---

## 1. Diagnóstico

### 1.1 Infraestrutura e arquitetura atuais

| Item | Situação | Evidência |
| --- | --- | --- |
| Hospedagem | **Não definida no repositório.** Não há Dockerfile, IaC nem configuração de provedor. O README descreve: SPA estática + API Node (`apps/api/dist/server.js`) + PostgreSQL 16 atrás de proxy reverso com TLS. CI no GitHub Actions com PostgreSQL efêmero. | `README.md` (Build e deploy), `.github/workflows/ci.yml` |
| Banco | PostgreSQL 16; papel dono (migrações) e papel de aplicação (DML, sem UPDATE/DELETE em tabelas somente inserção, com triggers). Migrações versionadas (`0001`–`0004`). | `apps/api/src/db/migrate.ts`, `migrations/` |
| Separação de dados | `institution_id` em todas as tabelas de negócio; escopo do usuário **por setor** (`user_scope`, `scope_all`). Não há escopo explícito por **unidade** (unidade é inferida pelos setores). Sem RLS no banco: o isolamento é aplicado nas consultas da API. | `0001_foundation.ts`, `repositories/clinical.ts` (`scopeIds`) |
| Auditoria | `audit_log` somente inserção com cadeia de hashes, gravado na mesma transação. | `apps/api/src/audit/audit.ts` |
| Tempo real | **Falta.** Só há atualização periódica (TanStack Query `refetchInterval: 120 s`) na lista e no contador de alertas. Nenhum SSE/WebSocket/LISTEN-NOTIFY. | `features/operations/AlertsPage.tsx` |
| Fila/outbox | **Falta.** Não há fila persistente nem padrão outbox. | — |
| Segredos | Somente por variáveis de ambiente validadas (`env.ts`); `.env.example` sem valores reais. Sem integração com cofre de segredos. | `apps/api/src/env.ts` |

### 1.2 CME — rastreabilidade e etapas

| Requisito | Situação | Detalhe |
| --- | --- | --- |
| Etapas operacionais (1–11) | **Falta** (7 parcial) | `processing_step` **não existe** (só no modelo-alvo do `DATA_MODEL.md`). O rastreio começa na **montagem da carga**: `load_item` nasce junto com `sterilization_load`. Não há recepção, limpeza, inspeção, preparo, embalagem, armazenamento, separação, distribuição nem devolução. A avaliação/liberação (etapa 7) **existe**. |
| Identidade física do material | **Parcial** | `instrument_set` é um **tipo** de caixa (catálogo), não a caixa física. Não há identificador permanente de cada caixa/instrumental, então não é possível acompanhar a mesma caixa entre reprocessamentos. |
| Código do pacote | **Parcial** | `load_item.label_code` (`<carga>-<nn>`, único por instituição) é gerado pelo sistema e aceito no uso cirúrgico e na pesquisa. Não há prefixo de tipo nem configuração de formatos. |
| Leitores de código de barras | **Falta** | Só campos de texto (`SurgeryMaterials.tsx`, `TracePage.tsx`). Não há cadastro de leitores/estações, modo de captura HID, câmera, nem registro de estação ou de método de entrada. |
| Validação de leitura | **Parcial** | `checkItemUse` (carga liberada, validade, uso único) e o índice único parcial `material_use_item_idx` cobrem o **uso**. Falta para todas as outras etapas, com resultado tipificado (código desconhecido, etapa incorreta, duplicidade etc.). |
| Registro de eventos de leitura | **Falta** | `material_use` registra o uso, não cada leitura; leituras recusadas não ficam registradas (só no log técnico). |
| Saída do CME / destino | **Falta** | O uso é registrado direto na cirurgia ou no setor (`/cme/uses`), sem saída, conferência ou destino. |
| Devolução / reentrada | **Parcial** | Reprocessamento de **carga** existe (`reprocessed_from_id`); devolução de pacote não usado e reentrada do material, não. |

### 1.3 Integrações, etiquetas, anexos

| Requisito | Situação | Detalhe |
| --- | --- | --- |
| Integração hospitalar (estoque, centro cirúrgico, internação, prontuário) | **Falta** | Nenhum adaptador. Só a coluna `culture.origin` (`manual`/`lis`) antecipa a integração com o laboratório. Não há mapeamento de códigos externos, inbox/outbox, idempotência nem registro de mensagens. |
| HL7/FHIR | **Falta** | Nenhuma dependência ou contrato. Nenhum endpoint de fornecedor documentado no repositório. |
| Geração e impressão de etiquetas | **Falta** | Nenhuma biblioteca ou gerador de código de barras, nenhum layout, nenhuma reimpressão auditada. Hoje o código é **só texto**. |
| Anexos | **Parcial** | Tipo pelo conteúdo, PDF ativo recusado, limite, disco fora da raiz web (permissões 700/600), download auditado (`services/attachments.ts`). **Falta**: antimalware, estado de verificação, criptografia em repouso na aplicação, armazenamento de objetos, URLs temporárias. |
| Importação de ciclos dos equipamentos | **Falta** | O registro físico é digitado (`POST /cme/loads/:id/cycle`). |

### 1.4 Alertas, fluxo, correção, parâmetros

| Requisito | Situação | Detalhe |
| --- | --- | --- |
| Central de alertas | **Parcial** | `alert` com deduplicação, supressão, eventos que não reabrem (`oneShot`), assumir/encerrar com resolução, visibilidade por permissão, filtros por situação/prioridade/tipo/"meus". **Falta**: categoria (erro operacional, violação de sequência, pendência por tempo, falha técnica, falta de informação, não conformidade, segurança), gravidade "crítica", prazo, distinção **visualizar / reconhecer / resolver / encerrar**, histórico de ações, filtros por unidade, setor e período, e alertas de bloqueio que não podem ser encerrados enquanto a condição persiste. |
| Alertas de quebra de processo | **Falta** (parcial em 4 casos) | Existem: carga recolhida, carga liberada com teste reprovado, Bowie-Dick reprovado com equipamento em uso, IB sem leitura, qualificação. Faltam os demais (material parado, etapa pulada, estação incompatível, saída sem liberação, ciclo aguardando decisão, leituras inválidas repetidas, falha de sincronização, divergência de estado). |
| Bloqueio de operação no servidor | **Parcial** | Já bloqueados: liberar sem a política permitir, ciclo em equipamento em manutenção, uso de pacote não liberado/vencido/já usado, segunda leitura de teste. Falta para as etapas novas e a **exceção autorizada** (permissão própria + justificativa + auditoria). |
| Correção versionada do ciclo | **Falta** | O fim do ciclo grava uma vez e recusa nova gravação (409). **Padrão reaproveitável**: versões de teste com `replaces_id` + justificativa (`sterilization_test`), versões de resultado de cultura, histórico de decisões com política aplicada. |
| Parâmetros governados | **Parcial** | `rule_parameter` tem valor, referência, `approved_by` e `row_version`; o histórico só existe no `audit_log`. **Problema**: o `approved_by` é preenchido por quem **edita** (edição = aprovação). Faltam unidade/contexto explícitos, vigência, versão consultável, situação de validação própria e separação **propor × aprovar**. A política de liberação tem o mesmo problema. A tela já marca "Valor inicial (demonstração)" e "Requer validação institucional" quando a referência não está validada. |

### 1.5 Testes existentes reaproveitáveis

Domínio (67), dados sintéticos (13), componentes (14), web (35), API com PostgreSQL real (71), E2E Playwright (6). Os testes de CME (`apps/api/test/cme.test.ts`, `packages/domain/src/cme/cme.test.ts`, `e2e/cme.spec.ts`) são a base de regressão.

---

## 2. Projeto técnico (Fase B)

### 2.1 Modelo de rastreabilidade proposto

Três identidades, cada uma com código de barras próprio e sem ambiguidade:

| Identidade | O que é | Código | Quando nasce |
| --- | --- | --- | --- |
| **Ativo** (`instrument_asset`) | Caixa ou instrumental físico rastreável (ex.: "Caixa de laparotomia nº 3"), ligado ao tipo `instrument_set` existente | Permanente, impresso em etiqueta durável. Prefixo `AT-` | Cadastro do ativo |
| **Processo** (`cme_process`) | Um ciclo completo de reprocessamento de um ativo (ou de material avulso), da recepção à distribuição/devolução | Ativo: o próprio código do ativo. Avulso: etiqueta de recepção `PR-` | Recepção (etapa 1) |
| **Pacote** (`load_item`, existente) | O pacote estéril | `label_code` atual (`<carga>-<nn>`); os códigos antigos continuam válidos | Montagem da carga (etapa 6), com impressão da etiqueta de esterilização (lote/ciclo/validade) |

Cadeia: **ativo → processo → (recepção … embalagem) → pacote → carga → ciclo → testes → decisão → armazenamento → separação → saída (setor de destino) → uso (cirurgia → paciente) → devolução → novo processo**.

Migração compatível: `load_item.process_id` **opcional**. Pacotes anteriores ficam marcados na interface como "rastreio iniciado no ciclo (registro anterior)". Nada é apagado ou reescrito.

### 2.2 Etapas e estados

`processing_step` passa a existir como **lista fixa no domínio** (não editável, para não quebrar regras):

1. `recepcao` · 2. `limpeza` · 3. `inspecao` · 4. `preparo` · 5. `embalagem` · 6. `esterilizacao` · 7. `liberacao` · 8. `armazenamento` · 9. `separacao` · 10. `distribuicao` · 11. `devolucao`

Estados do processo (separados da etapa): `em_processo`, `bloqueado`, `liberado`, `distribuido`, `devolvido`, `encerrado`, `descartado`.

- As transições permitidas ficam numa tabela `PROCESS_FLOW` no domínio, por exemplo: inspeção reprovada volta para limpeza ou vai para descarte; devolução abre um novo processo na recepção.
- Etapas obrigatórias: 1–7 e 10 sempre; 8 e 9 conforme a configuração da instituição. Isso é **parâmetro institucional, não decisão do desenvolvedor**.
- As etapas 6 e 7 reaproveitam carga, ciclo, testes e decisão existentes: o estado do processo é **derivado** da carga, sem duplicar.

### 2.3 Leitores e estações

**`scan_station`** — cadastro de estações e pontos de leitura. Campos:
- instituição, unidade, setor, localização e nome;
- etapas e operações permitidas;
- habilitada;
- símbolos aceitos (`code128`, `code39`, `qr`, `datamatrix`);
- métodos aceitos (`hid`, `camera`, `digitado`);
- identificador do dispositivo, opcional e **sem presumir número de série**;
- `last_seen_at`;
- responsável padrão.

**Vínculo da estação ao computador:**
- Um perfil autorizado "pareia" o navegador da estação.
- O servidor emite um token aleatório e guarda só o hash; o token vai num cookie `HttpOnly` próprio da estação.
- Assim a estação de cada evento é **conhecida pelo servidor**, não declarada pelo cliente.
- O usuário continua sendo o da sessão autenticada.

**Captura:**
- **HID (teclado)**: componente `ScanInput` que mantém o foco e detecta o padrão de leitor (intervalo entre teclas e terminador Enter/Tab configuráveis, prefixo/sufixo opcionais). Ele distingue leitura de digitação manual, e cada evento registra `input_method`.
- **Câmera** (dispositivos móveis): `BarcodeDetector` do navegador quando disponível, sem dependência externa. Onde não houver suporte, a câmera fica indisponível e isso é informado.
- **Digitação manual**: permitida conforme configuração da estação, e marcada no evento. Exigir justificativa é um parâmetro institucional.
- **Leitores com interface própria** (serial, SDK): fora do escopo até haver modelo e documentação do fabricante. A camada de captura fica preparada para um adaptador.

**Formatos (`barcode_format`):**
- Cada formato tem nome, simbologia, expressão regular, tipo de entidade, origem (sistema/hospital/fornecedor), prefixo e se está habilitado.
- O sistema reconhece os próprios códigos pelos prefixos (`AT-`, `PR-`) e pelo padrão de pacote atual.
- Códigos de terceiros só são aceitos se cadastrados e resolvidos por `external_identifier`.

### 2.4 Evento de leitura e serviço de transição

**`cme_scan_event`** (somente inserção) guarda:
- id e chave de idempotência (`client_event_id`, único por estação);
- código lido, tipo detectado, ativo/processo/pacote/carga resolvidos;
- etapa e operação solicitada;
- **resultado**: `aceita`, `codigo_desconhecido`, `etapa_incorreta`, `duplicada`, `bloqueado`, `carga_nao_liberada`, `destino_incompativel`, `requer_conferencia`, `excecao_autorizada`;
- usuário, estação, `input_method`;
- `server_at` (relógio do servidor) e `device_at` (informado, só como referência);
- origem e destino;
- justificativa;
- `previous_event_id` e o processo relacionado.

**Serviço único `scan(...)`**, executado numa transação com trava pelo processo/pacote:
1. Normaliza e identifica o código (formato → entidade).
2. Confirma se foi emitido pelo sistema ou está mapeado.
3. Carrega o estado atual.
4. Valida a etapa/operação contra a estação e o `PROCESS_FLOW`.
5. Verifica bloqueios (carga, recolhimento, validade, equipamento, alertas de segurança).
6. Grava o evento, **sempre, inclusive quando recusado**.
7. Só então avança o estado.
8. Grava no outbox.
9. Devolve um resultado tipificado em português para o operador.

**Regra central:** uma leitura com formato válido **nunca** autoriza movimento sozinha.

**Exceção autorizada:**
- Nova permissão `cme:override`, com justificativa obrigatória.
- Gera evento `excecao_autorizada`, alerta de categoria *segurança* e entrada no `audit_log`.

### 2.5 Alertas (evolução da Central existente, sem criar outra)

**Novas colunas em `alert`:**
- `category`: `erro_operacional`, `violacao_sequencia`, `pendencia_tempo`, `falha_integracao`, `informacao_obrigatoria`, `nao_conformidade`, `seguranca`;
- gravidade `critica` (somada a alta/média/baixa);
- `step`, `due_at`, `unit_id`;
- `acknowledged_at/by`, `resolved_at/by`;
- `blocking` (bloqueio de segurança).

**`alert_action`** (somente inserção) registra cada ação: criado, visualizado, reconhecido, assumido, comentado, resolvido, encerrado, reaberto, exceção.

**Regras:**
- Visualizar não muda a situação.
- Um alerta `blocking` não pode ser encerrado enquanto a condição persistir; a saída é resolver a causa ou uma exceção formal.

**Regras de quebra de processo** (em `collectCandidates`), com prazos em `rule_parameter` (grupo `cme`):
- **Sem prazo configurado, não há alerta de tempo.** Nenhum valor universal é definido pelo desenvolvedor.
- Detectadas a partir dos eventos de leitura: leituras inválidas repetidas (limite configurável), estação incompatível e tentativa de saída sem liberação.

**Filtros novos:** unidade, setor, gravidade, período, categoria, tipo e situação.

### 2.6 Tempo real

**Tecnologia:** **Server-Sent Events** (unidirecional, compatível com proxy HTTP, reconexão nativa com `Last-Event-ID`). A arquitetura atual não tem comando do cliente que precise de canal bidirecional.

**Entrega do evento:**
- **Outbox** `event_outbox` (id sequencial `bigserial`), gravado **na mesma transação** da mudança: o evento só existe se a transação confirmou.
- Um trigger `AFTER INSERT` faz `pg_notify` com o id. Notificação só é entregue após o commit; isso funciona com várias instâncias da API.
- Cada instância relê o outbox e envia a cada assinante **filtrando por permissão e escopo** (mesmas regras da API).
- O evento leva tópico e ids, nunca dados sensíveis. O cliente refaz a consulta autorizada.

**Reconexão e falhas:**
- Na reconexão, `Last-Event-ID` reenvia o que faltou, dentro da retenção do outbox (configurável).
- Se a lacuna for maior que a retenção, o cliente invalida todas as consultas.
- Falhas de publicação são registradas (`delivery_errors`) e geram alerta técnico acima de um limite.

**No cliente:**
- Invalidação seletiva das consultas do TanStack Query: sem recarregar a página, sem duplicar (o id do evento é deduplicado).
- Indicador de conexão (ativa / reconectando / atualização periódica).
- **Alternativa**: `REALTIME_MODE=sse|polling`, com intervalo configurável, para infraestrutura que não mantém conexão aberta.

### 2.7 Etiquetas

**Geração:**
- Codificador **Code 128** próprio no domínio (puro, sem dependência, testável), gerando SVG.
- QR Code só se houver justificativa operacional (decisão pendente).
- Code 39 apenas para **leitura** de códigos legados do hospital.

**Layouts (`label_layout`):**
- tamanho em mm, margens, campos exibidos e DPI;
- impressão pelo **navegador** (CSS de impressão no tamanho da etiqueta);
- geração **ZPL** para impressoras térmicas Zebra. O envio à impressora depende de serviço de impressão ou agente local (infraestrutura).

**`label_print`** (somente inserção):
- código, entidade e versão;
- impressa/reimpressa, com motivo obrigatório na reimpressão;
- situação `ativa` / `cancelada` / `substituida`, com referência à substituta.

**Conteúdo:** material, código, data de processamento, validade, ciclo/lote e situação de liberação quando pertinente. **Sem dado de paciente.**

**Validação:**
- **Automática**: teste que decodifica as barras do SVG gerado e confere o registro correspondente (ida e volta), mais teste visual da página de impressão.
- **Física** (impressão e leitura com o leitor real): **pendente de hardware**, com roteiro de validação.

### 2.8 Integração hospitalar

**Camada `apps/api/src/integrations/`:**
- Interface `HospitalAdapter`: `resolveCode`, `pushEvent`, `pullUpdates`, `health`.
- `integration_system`: cadastro com tipo (estoque, centro cirúrgico, internação, prontuário, laboratório, equipamento), adaptador, configuração **não secreta** e referência a segredo (variável de ambiente/cofre, nunca no banco em claro).
- `integration_message`: inbox/outbox com chave de idempotência única, hash do conteúdo, tentativas, último erro **sem dados sensíveis** e situação.
- `external_identifier`: código externo → entidade interna.

**Adaptadores entregues nesta etapa:**
- **arquivo CSV com mapeamento configurável**, para cargas iniciais de códigos do hospital;
- **adaptador de teste claramente identificado**, que não aparece como integração real.

**FHIR R4 e HL7 v2:**
- Interfaces e mapeamentos propostos (ex.: `Encounter`/`Procedure` para cirurgia, `Location` para setor).
- **Implementação só com o sistema real identificado.**
- **Não serão inventados** endpoints, credenciais nem contratos.

### 2.9 Anexos, nuvem e contingência

**Armazenamento de anexos:**
- `AttachmentStore` vira interface com duas implementações: `LocalDiskStore` (atual) e `S3CompatibleStore` (S3, MinIO, armazenamento de objetos do provedor), com criptografia no servidor e URLs temporárias de curta duração.
- Criptografia na aplicação (AES-256-GCM com versão de chave), seguindo o padrão do `field-crypto` existente, para o disco local e como camada adicional opcional.
- **Migração de arquivos existentes**: apenas por comando manual, com cópia, verificação de SHA-256 e relatório, sem apagar a origem, e somente após backup e autorização.

**Antimalware:**
- `attachment.scan_status`: `pendente`, `limpo`, `infectado`, `erro`.
- Download e uso **só** com `limpo`.
- Adaptador **ClamAV (clamd, protocolo INSTREAM documentado)**.
- Em produção, a API exige scanner configurado.
- Em desenvolvimento, o modo `off` mantém os arquivos como **pendentes**, nunca como aprovados.
- Teste com arquivo EICAR quando houver `clamd`; sem ele, teste com servidor clamd simulado, **identificado como tal**.

**Nuvem:**
- O repositório não define provedor. A proposta é **portável**: contêineres (API e web), configuração por ambiente, PostgreSQL gerenciado com criptografia em repouso e backups com teste de restauração, armazenamento de objetos, segredos em cofre do provedor e TLS no balanceador.
- Endpoints `/api/health` (vivo) e `/api/ready` (banco, armazenamento, antimalware e entrega de eventos).
- Documentação de backup, restauração, retenção/descarte (LGPD), monitoramento e contingência.
- **Nada disso será declarado em operação sem o ambiente aprovado.**

**Isolamento:**
- Escopo por **unidade** (além de setor) nas consultas e eventos.
- **RLS** do PostgreSQL por `institution_id` como defesa em profundidade (proposto, em etapa própria).

**Offline:**
- **Nenhuma liberação offline.**
- Fila local de leituras na estação (IndexedDB, com `client_event_id` e `device_at`) só se a instituição aprovar uma política.
- A reconciliação no servidor reaplica as mesmas regras; leituras recusadas geram alerta.
- Até a aprovação, a estação apenas avisa que está sem conexão e não aceita leituras.

### 2.10 Correção versionada do ciclo

`sterilization_load_revision` (somente inserção), reaproveitando o padrão de `replaces_id` dos testes:
- versão, campos alterados, antes/depois em `jsonb`;
- tipo `cadastral` (programa, observação, operador) ou `tecnica` (horários, temperatura, pressão, exposição);
- justificativa, solicitante e data;
- `requires_approval` (sempre para correção técnica), aprovação e situação (`pendente`, `aplicada`, `rejeitada`).

**Regras:**
- O **resultado físico nunca muda por correção**. "Não conforme → conforme" só por investigação formal (não conformidade). O inverso é permitido, porque é mais restritivo.
- Correção técnica aprovada em carga **já liberada**: a carga fica marcada para **reavaliação**, a saída dos pacotes é bloqueada até a nova decisão de um profissional com `cme:release`, e é gerado um alerta.
- A carga mostra a versão vigente e o histórico. Os vínculos com pacotes, testes, decisões e uso não mudam.

### 2.11 Importação de registros físicos (preparação da Fase 7)

`equipment_cycle_import`:
- equipamento, origem (arquivo/API/conector) e identificador externo do ciclo;
- início/fim, dados técnicos e alarmes (`jsonb`);
- SHA-256 do conteúdo, situação (`recebido`, `validado`, `vinculado`, `divergente`, `rejeitado`, `duplicado`), responsável/serviço e carga vinculada;
- divergências e histórico de reprocessamento (`equipment_cycle_import_attempt`, somente inserção).

**Regras:**
- Restrição única (equipamento, identificador externo) quando o identificador existir; senão, deduplicação por hash.
- Parser por **modelo de mapeamento configurável** (CSV), sem afirmar compatibilidade com nenhuma marca.
- **Importar nunca libera carga.**

### 2.12 Parâmetros governados

**Tabelas:**
- `rule_parameter_version` (somente inserção): chave, valor, unidade, contexto, referência, versão, proposto por, **aprovado por** (permissão nova `config:rules:approve`, separada de editar), vigência e situação (`demonstracao`, `proposto`, `aprovado`, `substituido`).
- `rule_parameter` continua guardando o valor vigente (compatibilidade). A política de liberação ganha `load_release_policy_version` no mesmo modelo.

**Migração:**
- Os valores atuais viram versão 1 com situação `demonstracao` em instalações de demonstração.
- Em instalações reais, a situação fica `proposto` (sem aprovação registrada).

**Interface:** selo "Demonstração — não aprovado" em toda tela que usa o parâmetro (alertas, validade de etiqueta, liberação).

### 2.13 Migrações planejadas

Todas aditivas, com `down`, sem reescrever dados:

| Nº | Conteúdo |
| --- | --- |
| 0005 | `instrument_asset`, `cme_process`, `scan_station`, `station_device`, `cme_scan_event` (somente inserção), `load_item.process_id` (opcional), fase de montagem da carga — aplicada |
| 0006 | Uso sem saída gera não conformidade + `user_notification` — aplicada |
| 0007 | Alertas v2: colunas novas + `alert_action` — aplicada |
| 0008 | `event_outbox` + trigger `pg_notify` — aplicada |
| 0009 | Funções e permissões (RBAC) — aplicada |
| 0010 | `label_layout`, `label_print`, `label_cancel` — aplicada |
| 0011 | Anexos: `attachment_scan`, `storage_backend`, `encryption`/`key_id`, `attachment_copy` — aplicada |
| 0012 | `integration_system`, `integration_message`, `external_identifier` (E1) |
| 0013 | `sterilization_load_revision`, `equipment_cycle_import`, `equipment_cycle_import_attempt` (H1/H2) |
| 0014 | `rule_parameter_version`, `load_release_policy_version` + preenchimento da versão 1 (I1) |

A numeração foi deslocada em relação à primeira versão deste plano porque a C5 (0006) e o RBAC (0009) entraram antes.

### 2.14 Permissões novas

| Permissão | Uso |
| --- | --- |
| `cme:scan` | Operar estações de leitura (técnicos sem acesso a decisões) |
| `cme:stations:configure` | Cadastrar e parear estações e formatos |
| `cme:override` | Exceção autorizada, com justificativa |
| `cme:correction:approve` | Aprovar correção técnica de ciclo |
| `integrations:manage` | Cadastrar integrações, ver mensagens técnicas |
| `config:rules:approve` | Aprovar parâmetros e política (separado de editar) |

### 2.15 Testes previstos (todos automatizados, contra PostgreSQL real quando envolvem API)

| Grupo | Exemplos |
| --- | --- |
| Domínio | `PROCESS_FLOW` (transições, etapa pulada, devolução); parser de códigos (prefixos, formatos do hospital, inválidos); Code 128 (codificação + **decodificação de volta**); regras de correção (resultado físico imutável); deduplicação de importação; classificação de alertas |
| API | Leitura aceita/recusada com resultado tipificado; idempotência; estação desabilitada ou de outra etapa; saída de carga não liberada bloqueada; exceção com `cme:override`; continuidade recepção → saída → uso; usuário/estação/horário gravados; isolamento por unidade; outbox só após commit (rollback não publica); SSE filtrado por permissão e replay por `Last-Event-ID`; alerta crítico não encerra com a condição ativa; reconhecer × resolver × encerrar; correção versionada e reavaliação; importação idempotente; antimalware (EICAR, pendente, infectado); regressão das suítes atuais |
| Web | `ScanInput` com leitura simulada por teclado (rajada + Enter) × digitação humana; feedback por resultado; indicador de conexão; reconexão sem duplicar |
| E2E | Recepção → limpeza → inspeção → preparo → embalagem → carga → liberação → armazenamento → saída → uso → devolução, com leituras por "teclado de leitor" no navegador; atualização ao vivo entre duas sessões |

**O que testes simulados não provam:** leitor físico, impressora, `clamd` de produção, nuvem e equipamentos. Cada item terá roteiro de validação física com evidência a anexar.

---

## 3. Ordem de execução (etapas pequenas e reversíveis)

| Etapa | Entrega | Critério de aceite |
| --- | --- | --- |
| **C1** | Domínio: etapas, `PROCESS_FLOW`, estados, parser de códigos, resultados tipificados | Testes de domínio |
| **C2** | Migração 0005 + estações (cadastro, pareamento, token) + ativos + serviço `scan` (recepção → embalagem) | Testes de API (aceita/recusa/idempotência/estação) |
| **C3** | Carga a partir de leituras (etapa 6), armazenamento, separação, saída com destino, devolução; uso cirúrgico exige saída (com período de transição configurável) | Continuidade recepção → uso; bloqueios |
| **C4** | Interface: `ScanInput` (HID + câmera), telas de estação por etapa, linha do tempo do processo, rastreabilidade estendida | Testes de interface + E2E com leitor simulado por teclado |
| **D1** | Alertas v2 (0007): categorias, gravidade crítica, ciclo de ações, filtros, bloqueio | Testes de API/interface |
| **D2** | Regras de quebra de processo com prazos configuráveis + exceção autorizada | Testes de API |
| **G1** | Outbox + SSE (0008), filtro por permissão/escopo, replay, indicador de conexão, modo periódico | Testes de API e E2E com duas sessões |
| **F1** | Code 128, layouts, impressão pelo navegador, ZPL, reimpressão auditada (0010) | Decodificação automática; roteiro físico pendente |
| **F2** | Anexos: interface de armazenamento, criptografia, situação da verificação, ClamAV (0011) | EICAR/simulado; download bloqueado sem `limpo` |
| **E1** | Camada de integração (0012), `external_identifier`, inbox idempotente, adaptador CSV e de teste | Testes de idempotência e de não exposição de dados |
| **H1** | Correção versionada do ciclo (0013 parte) | Histórico preservado; reavaliação de carga liberada |
| **H2** | Importação de ciclos (0013 parte) | Idempotência; não libera |
| **I1** | Parâmetros governados (0014) | Propor × aprovar; selo de demonstração |
| **G2** | Nuvem/contingência: contêineres, `/api/ready`, documentação de backup/DR/retenção | Revisão; sem declarar ambiente em operação |
| **I2** | Validação final, revisão de segurança, relatório | Todas as suítes + E2E no modo CI |

Cada etapa termina com lint, typecheck, testes, build, commit e relatório (funcionalidades, arquivos, migrações, testes, regras, limitações, dependências e aprovações).

---

## 3.1 Decisões aprovadas (09/10/2026)

| # | Decisão | Aplicação |
| --- | --- | --- |
| 1 | Etiqueta do pacote impressa na **montagem da carga** | A carga passa a ter a fase "em montagem" (antes do início do ciclo); cada pacote lido na montagem recebe a etiqueta com lote/ciclo e validade |
| 2 | Etapas obrigatórias: todas, exceto **armazenamento** e **separação**, que são configuráveis | `cme_flow_config.storage_required` / `separation_required` |
| 3 | Uso cirúrgico sem saída registrada **nunca bloqueia** (revisto em 10/10/2026) | O uso é registrado e, na mesma transação, abre uma não conformidade (origem CME) vinculada ao uso e notifica o usuário que registrou o uso; a CME também recebe alerta. O bloqueio por data foi removido (migração 0006) |
| 4 | Sem operação offline até existir política institucional | A estação sem conexão avisa e não aceita leituras; liberação nunca é offline |
| 5 | Antivírus **somente quando disponível** | Sem scanner configurado, o arquivo fica "não verificado" (sinalizado, nunca exibido como aprovado); com scanner, só fica disponível após resultado "limpo" |
| 6 | Code 128 para códigos emitidos; leitura de Code 39 legado; sem QR Code. **Sem leitor, conferência manual no sistema** | O modo manual é oficial por estação: o operador localiza e confirma o item; o servidor aplica as mesmas regras e o evento fica marcado como `manual` |
| 7 | Conferência manual **sem justificativa** (10/10/2026) | Após a conferência o material segue para a próxima etapa; a estação oferece "Continuar: <próxima etapa>" quando atende essa etapa |

## 4. Dependências externas e aprovações institucionais

**Hardware e fornecedores:**
- Modelo dos leitores e configuração de sufixo (Enter/Tab).
- Modelo e linguagem das impressoras (ZPL/EPL/outra) e tamanho das etiquetas.
- Equipamentos da CME e formato de exportação dos ciclos.
- Sistemas hospitalares existentes (estoque, centro cirúrgico, prontuário) e seus padrões de código e APIs.
- Servidor antimalware.

**Infraestrutura:**
- Provedor ou modelo de hospedagem.
- Armazenamento de objetos e cofre de segredos.
- Política de backup/restauração e de retenção.
- Suporte a conexões SSE no proxy.

**Aprovações institucionais:**
- Etapas obrigatórias e prazos de cada uma.
- Momento da impressão da etiqueta (embalagem × montagem da carga).
- ~~Exigência de justificativa para digitação manual~~ — decidido em 10/10/2026: não exige.
- Política offline.
- Quem aprova correções técnicas.
- Parâmetros de validade, leitura do IB e qualificação.
- Política de liberação.
- ~~Período de transição em que o uso cirúrgico é aceito sem saída registrada~~ — decidido em 10/10/2026: o uso nunca é bloqueado; gera não conformidade e notificação.

## 5. Riscos

| Risco | Mitigação |
| --- | --- |
| Adoção parcial (etapas sem leitura) gera muitos alertas | Etapas 8–9 configuráveis; prazos sem valor padrão; uso sem saída gera não conformidade em vez de bloquear |
| Leitores HID com sufixo/velocidade diferentes | Detecção configurável por estação; teste de leitura na configuração da estação |
| Leitura "válida" usada para pular etapa | Validação central no servidor; exceção só com permissão e auditoria |
| Perda de evento entre banco e tela | Outbox na mesma transação + replay por id + modo periódico |
| Arquivo malicioso disponível antes da verificação | `scan_status` obrigatório; download só `limpo` |
| Correção mascarar falha | Resultado físico imutável; correção técnica exige aprovação e reavaliação |
| Duplicidade em sincronização/integração | Idempotência por chave única em eventos, mensagens e importações |

## 6. Andamento

| Etapa | Situação | Evidência |
| --- | --- | --- |
| C1 | Concluída | Testes de domínio (códigos com dígito verificador, decisões de leitura, exceção, detecção de leitor) |
| C2/C3 | Concluídas | Migração 0005; testes de API contra PostgreSQL (continuidade, regra de saída, recusas, idempotência, exceção, pareamento, acesso) |
| C4 | Concluída | Testes de interface (campo de leitura, idempotência no reenvio, exceção, conferência manual) e E2E do fluxo completo com leitor simulado por teclado |
| C5 | Concluída | Migração 0006; testes de API (não conformidade + notificação só para quem registrou, leitura da notificação, notificação não pode ser excluída, conferência manual sem justificativa) e de interface (sino com contador, marcar como lida, continuar na próxima etapa) |
| D1 | Concluída | Migração 0007; testes de domínio (categorias, bloqueio, ações permitidas, gravidade crítica), de API (ciclo completo com histórico, filtros, visualizar não muda a situação, bloqueante não encerra à mão, exceção só com permissão e sem recriação, histórico imutável) e de interface |
| D2 | Concluída | Testes de domínio (nenhum alerta sem valor institucional; cada prazo vale só para a sua etapa; eventos) e de API contra PostgreSQL (prazo não configurado não alerta; prazo configurado alerta e o alerta se encerra sozinho com a leitura seguinte; carga aguardando decisão; leituras recusadas repetidas; estação incompatível; tentativa de saída sem liberação) |
| G1 | Concluída | Migração 0008; testes de API com servidor real (só após commit; permissão; escopo de setor; destinatário pessoal; reenvio por Last-Event-ID; reset quando a lacuna é antiga; encerramento ao fim da sessão; modo periódico), de interface (invalidação por tópico sem duplicar; queda → periódico) e E2E com duas sessões |
| F1 | Concluída (validação física pendente) | Migração 0010; testes de domínio (ida e volta de cada código pelo decodificador próprio **e por um leitor independente, ZXing**; leitura do SVG gerado; ajuste do módulo a pontos inteiros da impressora; layouts que não comportam o código ou os campos; ZPL com a mesma sequência de subconjuntos e sem injeção de comandos), de API contra PostgreSQL (conteúdo lido dos registros e sem paciente; segunda impressão recusada; reimpressão só com motivo, substituindo a anterior; cancelamento só da etiqueta em uso; impressão e cancelamento imutáveis; lote em ZPL; carga rejeitada recusada; permissões), de interface e **E2E que imprime no Chromium, captura a etiqueta em modo de impressão e a decodifica com ZXing** |
| F2 | Concluída (provedor S3 real e base oficial do ClamAV pendentes) | Migração 0011; testes de domínio (disponibilidade por situação), da assinatura S3 com o vetor oficial da AWS, da cifragem (repouso, adulteração, nome trocado, chave anterior), do adaptador ClamAV com clamd simulado **e com o ClamAV 1.5.4 real (EICAR em PDF detectado, PDF limpo aprovado)**, e de API (ameaça recusada sem gravar nada; falha do antivírus deixa indisponível até nova verificação; arquivo antigo bloqueado e descartado se infectado; adulteração no disco bloqueada e registrada; migração simulada × aplicada com conferência e origem preservada; verificação em lote; histórico imutável) e de interface |
| F3 em diante | Pendentes | — |

**O que F2 entrega:** veja [03-ANEXOS-OPERACAO.md](03-ANEXOS-OPERACAO.md). Em resumo: verificação ClamAV antes de gravar (ameaça recusada, sem gravar), situação de cada arquivo com a regra aprovada em 09/10/2026 (sem antivírus: "não verificado", sinalizado; com antivírus: só abre depois de limpo), "Verificar novamente", cifragem AES-256-GCM com chaves nomeadas e troca de chave, conferência de integridade em toda leitura, armazenamento local ou compatível com S3, comando `attachments verificar | migrar` com simulação, conferência e origem preservada.

**Diferença em relação ao plano:** o plano previa exigir antivírus em produção; prevaleceu a decisão de 09/10/2026 ("antivírus somente quando disponível"). Em compensação, a cifragem dos anexos é obrigatória em produção. Links temporários do armazenamento não são usados: o download passa pela API para manter permissão e log em todo acesso. O endpoint de prontidão (`/api/ready`) com armazenamento e antivírus fica para G2.

**O que F1 entrega:**
- Codificador Code 128 próprio (`packages/domain/src/cme/barcode.ts`): subconjuntos B e C (sequências de dígitos em pares), dígito de verificação, zonas de silêncio de 10 módulos, SVG e decodificador usado como conferência.
- Layouts (`label_layout`) por tipo de etiqueta — pacote estéril, ativo, recepção de material avulso — com largura, altura, margem, resolução (203/300/600 dpi), altura das barras e campos. A largura do módulo é ajustada a pontos inteiros da impressora (mínimo 2 pontos e 0,165 mm); um layout que não comporta o código típico ou os campos é recusado com a medida necessária. A etiqueta do pacote estéril sempre mostra a validade. **Não há tamanho padrão de fábrica**: o seed traz layouts de demonstração (70×40 e 50×25 mm a 203 dpi), sinalizados.
- Conteúdo lido dos registros no momento da impressão: material, código, data de processamento, validade, lote (carga), equipamento e programa, embalagem, aviso de implantável, conjunto, identificação do ativo e, opcionalmente, a situação de liberação (fica fixa no papel). **Nenhum dado de paciente.**
- Impressão pelo navegador no tamanho real (`@page` do layout, uma etiqueta por página, só as etiquetas são impressas) e arquivo **ZPL II** (UTF-8, tamanho em pontos, barras com os mesmos códigos de início e troca de subconjunto do SVG, texto escapado por `^FH`). O envio direto à impressora depende de serviço ou agente de impressão local (infraestrutura, não instalado).
- `label_print` e `label_cancel` somente inserção: impressão, reimpressão (motivo obrigatório; a anterior passa a "substituída") e cancelamento (motivo obrigatório). A situação (ativa, substituída, cancelada) é derivada desses registros. Impressões simultâneas do mesmo registro são serializadas.
- Permissões existentes, sem nova permissão: imprimir e reimprimir com `cme:scan` ou `cme:cycle:record`; cancelar com `cme:cycle:record`; layouts com `cme:stations:configure`; histórico com `cme:view`. Carga rejeitada ou em reprocessamento, ativo baixado e processo encerrado não recebem etiqueta.
- Telas: botão por pacote e "Imprimir etiquetas pendentes" na carga; etiqueta por ativo (e logo após a emissão dos códigos) em Materiais; etiqueta de recepção no processo de material avulso; página **CME → Etiquetas** com layouts (pré-visualização em tamanho real) e histórico pesquisável.

**Limitações de F1:** impressão e leitura com equipamento real ainda não validadas (roteiro em [02-ROTEIRO-VALIDACAO-ETIQUETAS.md](02-ROTEIRO-VALIDACAO-ETIQUETAS.md)); sem envio direto à impressora; ZPL é a única linguagem de impressora térmica (EPL/outras dependem do modelo adotado); o texto do ZPL é encurtado por estimativa de largura da fonte escalável.

**O que C4 entrega:** tela "Estação de leitura" (escolha da estação, etapa, campo que distingue leitor × digitação pelo intervalo entre teclas, câmera via `BarcodeDetector` quando o navegador oferece, conferência manual no sistema, resultado da leitura com o motivo, exceção autorizada, últimas leituras); "Processos" (lista e trilha de cada rodada, com leituras recusadas); "Estações e fluxo" (regras institucionais, cadastro de estações, pareamento de computadores); "Materiais" (emissão de códigos de ativos); carga "em montagem" com início do ciclo; links da rastreabilidade para a trilha do processo.

**Ajustes feitos durante a validação:**
- A CME passou a receber a lista de setores do hospital por `GET /cme/sectors` (só nomes, sem dados de paciente). Antes, um usuário da CME com escopo restrito ao próprio setor não via os destinos de saída nem o nome do setor de uso na rastreabilidade.
- O limite geral de requisições (300/min) passou a ser contado por sessão autenticada, e não por IP: estações de uma CME ou um hospital inteiro atrás de um mesmo NAT não dividem mais o mesmo limite. Login e troca de senha continuam limitados por IP, e um cookie de sessão inventado não abre novo limite.

**Ainda não validado (depende de hardware):** leitura com leitores físicos (sufixo, velocidade, Code 39 legado), câmera em tablets/celulares da CME. O E2E simula o leitor por teclado; isso não substitui o roteiro com os modelos reais.

**O que C5 entrega (decisões de 10/10/2026):**
- Uso de pacote sem saída registrada: nunca bloqueia. Abre uma não conformidade (origem CME, gravidade média, setor do uso) com a origem "uso de material" e o usuário notificado, registrada no log de auditoria; a mesma requisição repetida não abre outra.
- Notificações pessoais: sino no cabeçalho com o número de não lidas e a página "Notificações". Cada usuário vê só as suas; marcar como lida não apaga (o banco recusa exclusão). O texto é completo mesmo para quem não tem acesso ao módulo de qualidade; o link para a não conformidade só aparece para quem pode abri-la.
- Conferência manual sem justificativa; depois de uma leitura ou conferência aceita, a estação oferece seguir para a próxima etapa quando a atende.
- Migração 0006 remove `exit_required_from` e `manual_requires_justification` de `cme_flow_config`.

**O que D1 entrega (Central de Alertas v2, a mesma tabela `alert`, sem um segundo sistema):**
- Categoria (erro operacional, violação de sequência, pendência de tempo, falha de integração, informação obrigatória ausente, não conformidade, segurança do paciente), gravidade **crítica**, prazo, etapa da CME e unidade.
- Ciclo: aberto → reconhecido → assumido → resolvido → encerrado. Visualizar o detalhe registra "visualizado" (uma vez por usuário) e não muda a situação. Comentários entram no histórico.
- `alert_action` (somente inserção, protegida por gatilho) guarda cada ação com usuário, data e nota; alertas anteriores à migração receberam o histórico reconstituído (criado, assumido, encerrado).
- Alertas **bloqueantes** (carga liberada com teste reprovado; Bowie-Dick reprovado com equipamento em uso): não podem ser encerrados à mão enquanto a condição existir. Saída: corrigir a causa (o sistema encerra sozinho) ou **exceção formal** com a permissão `alerts:exception` (concedida por padrão a Administrador e Enfermeiro(a) CCIH), justificativa obrigatória; a mesma situação não volta a alertar.
- Gravidade crítica: carga recolhida com paciente exposto, carga liberada que passou a reprovar, Bowie-Dick reprovado. O contador do menu soma crítica + alta.
- Filtros: situação, gravidade, categoria, tipo, unidade, setor, período de criação, só bloqueantes, só os meus.

**Aprovação pendente:** quais perfis recebem `alerts:exception` e quais tipos de alerta são bloqueantes (hoje: os dois de segurança da esterilização).

**O que D2 entrega (regras de quebra de processo da CME, na Central de Alertas):**
- Parâmetros novos em Administração › Parâmetros (grupo CME), **todos sem valor padrão** — sem valor, a regra não é aplicada:
  tempo máximo entre recepção e limpeza, limpeza e inspeção, inspeção e preparo, preparo e embalagem, embalagem e montagem da carga; tempo máximo entre o fim do ciclo e a decisão de liberação; quantidade de leituras recusadas e a janela (minutos) para contá-las.
- Alertas: material parado numa etapa além do prazo (contado a partir da última leitura aceita); carga aguardando decisão além do prazo; leituras recusadas repetidas numa estação; leitura em estação incompatível (evento, uma vez por estação e dia); tentativa de saída sem liberação (evento por processo, gravidade alta).
- Os alertas de tempo se encerram sozinhos quando a leitura seguinte (ou a decisão) acontece.

**Aprovação pendente:** os valores de cada prazo e do limite de leituras recusadas (decisão institucional; o sistema não sugere números).

**O que G1 entrega (tempo real):**
- `event_outbox` gravado na mesma transação da mudança (pela auditoria, que já acompanha toda alteração, e explicitamente na leitura da CME, na geração de alertas e nas notificações pessoais); gatilho `pg_notify` — só é anunciado o que foi confirmado.
- `GET /api/events` (Server-Sent Events): cada instância da API escuta o banco e envia a cada conexão só o que ela pode ver (instituição, permissão, setor do escopo, destinatário pessoal). O evento leva apenas id e tópico; a tela relê os dados pelas rotas autorizadas. Reconexão com `Last-Event-ID` reenvia o que faltou dentro da retenção; lacuna maior envia "reset" (a tela atualiza tudo). A conexão é encerrada quando a sessão termina (saída, revogação, inatividade ou tempo máximo); permissões alteradas valem na próxima conexão.
- Cliente: invalida só as consultas do tópico, ignora ids repetidos, mostra "Tempo real" / "Reconectando…" / "Atualização periódica" no cabeçalho e, sem conexão, atualiza periodicamente.
- Configuração: `REALTIME_MODE=sse|polling`, `REALTIME_POLL_SECONDS`, `REALTIME_RETENTION_HOURS`, `REALTIME_MAX_CONNECTIONS` (ver `.env.example`). Administradores veem o estado da escuta em `GET /api/realtime`.

**Limitações e dependências:** o proxy reverso precisa permitir SSE sem buffer e conexões longas (o servidor envia `X-Accel-Buffering: no` e um sinal a cada 25 s); um evento confirmado fora de ordem durante uma reconexão pode não ser reenviado (a próxima mudança do mesmo tópico ou o modo periódico corrigem); o alerta técnico para falhas repetidas de entrega fica para G2 (hoje os contadores aparecem em `GET /api/realtime`).
