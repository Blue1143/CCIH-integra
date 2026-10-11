# Roteiro de validação física das etiquetas (F1)

A geração do código de barras é verificada automaticamente: cada símbolo é decodificado de volta pelo próprio sistema e, nos testes, por um leitor independente (ZXing), inclusive a partir da imagem da etiqueta renderizada no navegador. **Isso não substitui a validação com a impressora e o leitor reais da CME.** Até a execução deste roteiro, a impressão física é considerada **não validada**.

## Pré-requisitos

- Impressora adotada (modelo, linguagem — ZPL ou outra — e resolução em dpi) e rolo de etiquetas com as medidas definidas.
- Leitor(es) das estações configurados (sufixo Enter/Tab conforme a estação).
- Layout cadastrado em **CME → Etiquetas** com as medidas reais (largura, altura, margem, resolução) e marcado como padrão.
- Ambiente de homologação com dados sintéticos.

## Testes

| # | Teste | Como | Critério de aceite |
| --- | --- | --- | --- |
| 1 | Tamanho | Imprimir uma etiqueta de pacote pelo navegador (escala 100%, sem margens do navegador) | Medidas dentro de ±0,5 mm do layout; nada cortado |
| 2 | Leitura do pacote | Ler a etiqueta com o leitor de cada estação | O código lido é idêntico ao impresso (conferir na tela "Últimas leituras") em 10 leituras seguidas |
| 3 | Leitura do ativo | Repetir com etiqueta de ativo (`AT-`) e de recepção avulsa (`PR-`) | Idem; o dígito verificador é aceito |
| 4 | ZPL | Enviar o arquivo `.zpl` à impressora térmica (pelo utilitário do fabricante ou serviço de impressão) | Mesmo conteúdo e medidas da impressão pelo navegador; leitura idêntica ao teste 2 |
| 5 | Durabilidade | Submeter etiquetas ao processo real (autoclave, manuseio, armazenamento) | Leitura ainda idêntica após o ciclo; texto legível |
| 6 | Distância e ângulo | Ler a 5, 10 e 20 cm e inclinada | Registrar o alcance aceito para o leitor adotado |
| 7 | Reimpressão | Reimprimir com motivo e ler a nova etiqueta | Nova etiqueta "ativa", anterior "substituída"; ambas leem o mesmo código (o código do pacote não muda) |
| 8 | Fallback | Simular etiqueta ilegível | Conferência manual na estação localiza o item pelo código impresso em texto |

## Registro

Para cada teste: data, executor, modelo e firmware da impressora e do leitor, layout usado, resultado e evidência (foto da etiqueta e captura da tela de leituras). Anexar o registro ao processo de aprovação institucional. Ajustes de tamanho, margem ou altura das barras são feitos no layout (fica no log de auditoria) e o teste correspondente é repetido.
