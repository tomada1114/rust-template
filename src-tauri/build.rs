//! Tauri's build step: reads `tauri.conf.json` and the capabilities, and checks that
//! every `bundle.externalBin` file exists (run `just sidecar` first).

fn main() {
    tauri_build::build();
}
