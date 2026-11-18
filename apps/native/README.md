# Aplicativos instalados (`@ccih/native`)

Windows e Mac com [Tauri](https://tauri.app) (`src-tauri/`), Android e iPhone com [Capacitor](https://capacitorjs.com). Os aplicativos abrem o sistema do servidor da organização (`CCIH_SERVER_URL`, sempre HTTPS); não guardam dados no aparelho e a janela só navega para esse servidor.

Implantação e instalação: [docs/implantacao/02-APLICATIVOS-E-SERVIDOR-NO-ESCRITORIO.md](../../docs/implantacao/02-APLICATIVOS-E-SERVIDOR-NO-ESCRITORIO.md).

| Comando (nesta pasta) | O que faz |
| --- | --- |
| `CCIH_SERVER_URL=https://… npm run start-page` | Gera `www/` (página de conexão) e `capacitor.config.json` |
| `CCIH_SERVER_URL=https://… npm run desktop:build` | Instalador do computador atual (Windows: `.exe`/`.msi`; Mac: `.dmg`) |
| `CCIH_SERVER_URL=http://localhost:5173 npm run desktop:dev` | Aplicativo de computador apontando para o ambiente local |
| `CCIH_SERVER_URL=https://… npm run mobile:add` | Gera os projetos `android/` e `ios/` (permissão de câmera e ícones) |
| `npm test` | Testes da validação do endereço; `cargo test` em `src-tauri/` testa a navegação restrita |

- `start/`: página de conexão (verifica `/api/ready` do servidor e abre o sistema, ou explica o problema e tenta de novo).
- `assets/`: ícone de origem (gerado do logotipo) e a versão opaca exigida pelo iPhone. `src-tauri/icons/` foi gerado com `npx tauri icon assets/icon-source.png -o src-tauri/icons`.
- `android/`, `ios/`, `www/` e `capacitor.config.json` são gerados a cada build (não versionados).
- Requisitos locais: Node 22; Rust (computador); no Linux, `libwebkit2gtk-4.1-dev`; Android Studio/JDK 21 (Android); Xcode no Mac (iPhone). A automação `.github/workflows/apps.yml` gera tudo sem instalar nada localmente.
