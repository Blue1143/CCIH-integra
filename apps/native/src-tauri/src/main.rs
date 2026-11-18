// CCIH Integra for Windows and Mac: a window that opens the organization's system from its server.
// No data is kept on the computer by the app itself, and the system pages get no access to it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Url, WebviewUrl, WebviewWindowBuilder};

/// Server of this build (validated by scripts/server-url.mjs before the build).
const SERVER: &str = env!("CCIH_SERVER_URL", "Defina CCIH_SERVER_URL com o endereço do servidor.");

/// Only the bundled connection page and the organization's server open inside the window.
fn allowed(url: &Url, server: &Url) -> bool {
    let bundled = url.scheme() == "tauri" || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"));
    let own_server = url.scheme() == server.scheme() && url.host_str() == server.host_str() && url.port_or_known_default() == server.port_or_known_default();
    bundled || own_server
}

fn main() {
    let server = Url::parse(SERVER).expect("CCIH_SERVER_URL inválida");
    tauri::Builder::default()
        .setup(move |app| {
            let server = server.clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("CCIH Integra")
                .inner_size(1280.0, 820.0)
                .min_inner_size(960.0, 600.0)
                .on_navigation(move |url| allowed(url, &server))
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o CCIH Integra");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_only_the_bundled_page_and_the_server() {
        let server = Url::parse("https://ccih.escritorio.ts.net").unwrap();
        for ok in ["tauri://localhost/index.html", "http://tauri.localhost/index.html", "https://ccih.escritorio.ts.net/consultoria/agenda", "https://ccih.escritorio.ts.net:443/"] {
            assert!(allowed(&Url::parse(ok).unwrap(), &server), "{ok}");
        }
        for blocked in ["https://exemplo.com/", "http://ccih.escritorio.ts.net/", "https://ccih.escritorio.ts.net:8443/", "https://ccih.escritorio.ts.net.exemplo.com/"] {
            assert!(!allowed(&Url::parse(blocked).unwrap(), &server), "{blocked}");
        }
    }
}
