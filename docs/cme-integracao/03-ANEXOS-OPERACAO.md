# Anexos: antivírus, cifragem e armazenamento (F2)

Evidências (folha de Bowie-Dick, impressões do ciclo, listas de presença) aceitas em PDF, PNG ou JPEG, com o tipo decidido pelo conteúdo e PDF com conteúdo ativo recusado (já existia). F2 acrescenta a verificação por antivírus, a cifragem na aplicação, o armazenamento em objetos compatível com S3 e o comando de manutenção.

## Regra de disponibilidade (decisão institucional de 09/10/2026)

| Situação | Quando | Abre o arquivo? |
| --- | --- | --- |
| Não verificado (sem antivírus) | `ANTIVIRUS=off` e o arquivo nunca foi verificado | Sim, sempre sinalizado; nunca aparece como aprovado |
| Aguardando verificação | Antivírus configurado e o arquivo ainda sem verificação (ex.: enviado antes do antivírus) | Não |
| Falha na verificação | O antivírus não respondeu ou respondeu erro | Não, até "Verificar novamente" dar limpo |
| Verificado pelo antivírus | Resultado limpo | Sim |
| Ameaça detectada | No envio: **nada é gravado** e a tentativa fica no log com a assinatura. Numa nova verificação: o conteúdo é descartado | Não |

Cada verificação fica registrada (`attachment_scan`, somente inserção) com o motor e a versão das assinaturas; a mais recente decide. O servidor aplica a regra em todo download; a tela só mostra o link quando o arquivo pode ser aberto.

## Antivírus (ClamAV)

- Configure `ANTIVIRUS=clamav`, `CLAMAV_HOST`, `CLAMAV_PORT` (3310) e `CLAMAV_TIMEOUT_MS`. A API conversa com o `clamd` pelo comando `INSTREAM` documentado pelo ClamAV; o arquivo não passa por disco no servidor do antivírus.
- O `clamd` precisa de assinaturas atualizadas (`freshclam` com acesso a `database.clamav.net` ou a um espelho interno). Sem assinaturas atualizadas o antivírus não protege: isso é responsabilidade da infraestrutura.
- Arquivos enviados antes do antivírus ficam "aguardando verificação": rode `npm run attachments -w @ccih/api -- verificar` depois de configurar.

**Validação feita:** testes automáticos com um `clamd` simulado (sempre executados) e com o **ClamAV 1.5.4 real** neste ambiente: o arquivo de teste EICAR dentro de um PDF foi detectado e o PDF limpo passou (`CLAMAV_TEST_HOST=host:porta` ativa esse teste). A base oficial de assinaturas não pôde ser baixada aqui (rede bloqueada); a detecção usou uma **assinatura local de teste** para o EICAR. A validação com a base oficial fica para o ambiente da instituição.

## Cifragem na aplicação

- AES-256-GCM, chave de 32 bytes com nome (`ATTACHMENT_ENCRYPTION_KEY` e `ATTACHMENT_ENCRYPTION_KEY_ID`), **obrigatória em produção** (a API não sobe sem ela). Em desenvolvimento é opcional.
- O conteúdo cifrado fica preso ao nome do arquivo no armazenamento (dado associado): copiado para outro nome, não abre. Toda leitura confere o SHA-256 do conteúdo original; divergência bloqueia o download, responde "integridade" e fica no log.
- **Troca de chave:** gere a nova, mova a atual para `ATTACHMENT_ENCRYPTION_PREVIOUS_KEYS` (`id:base64;id:base64`), configure a nova como atual, reinicie e rode `migrar --recifrar --aplicar`. Só retire a chave anterior depois que o relatório mostrar todos os arquivos recifrados.
- As chaves ficam no cofre de segredos do ambiente; nunca no repositório, em arquivos versionados ou em logs.

## Armazenamento

- `ATTACHMENT_STORAGE=local` (padrão): `UPLOAD_DIR`, fora da raiz web, diretórios 700 e arquivos 600, nunca sobrescritos.
- `ATTACHMENT_STORAGE=s3`: Amazon S3, MinIO ou o armazenamento de objetos do provedor que implemente a API S3. Assinatura AWS Signature Version 4 implementada no servidor (sem SDK) e conferida com o exemplo publicado pela AWS; `S3_FORCE_PATH_STYLE=true` para MinIO; `S3_SERVER_SIDE_ENCRYPTION=AES256` pede cifragem também no provedor. O download continua passando pela API (permissão e log a cada acesso): não são entregues links temporários ao navegador.
- **Validação feita:** assinatura conferida com o vetor de teste oficial e fluxo completo contra um **servidor S3 simulado**. **Não houve teste contra um provedor real**: fazer em homologação antes de usar.

## Comando de manutenção

```
npm run attachments -w @ccih/api -- verificar
npm run attachments -w @ccih/api -- migrar [--recifrar] [--aplicar]
```

- `verificar`: verifica todo arquivo ainda não limpo; ameaças têm o conteúdo descartado.
- `migrar`: copia cada arquivo para o armazenamento configurado (e recifra com a chave atual com `--recifrar`). Sem `--aplicar`, só mostra o plano. Cada cópia é lida de volta e conferida (SHA-256) antes de ser registrada (`attachment_copy`, somente inserção); **a origem nunca é apagada**. Arquivos com ameaça não são copiados.
- Rode só depois do backup e com autorização. O relatório lista cada arquivo (identificador, situação) e nunca mostra conteúdo nem chaves.
