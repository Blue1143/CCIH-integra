fn main() {
    // The server address is part of each build (see apps/native/README.md).
    println!("cargo:rerun-if-env-changed=CCIH_SERVER_URL");
    tauri_build::build()
}
