mod menu;

use tauri::{Manager, RunEvent};

use crew_core::agent::AgentHost;
use crew_core::bridge::Bridge;
use crew_core::pty::PtyHost;
use crew_core::store::Store;
use crew_protocol::DaemonInfo;
use crewd::{serve, Config, Handle};

#[tauri::command]
fn daemon_info(daemon: tauri::State<Handle>) -> DaemonInfo {
    daemon.info.clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            app.set_menu(menu::build(app)?)?;
            let dir = app.path().app_data_dir()?;
            let store = Store::open(dir.join("crew.sqlite3"))?;
            let pty = PtyHost::new();
            let agents = AgentHost::new();
            let bridge = Bridge::start(dir)?;
            let daemon = serve(Config {
                pty: pty.clone(),
                store,
                agents: agents.clone(),
                bridge: bridge.clone(),
            })
            .map_err(|e| e.to_string())?;
            app.manage(pty);
            app.manage(agents);
            app.manage(bridge);
            app.manage(daemon);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![daemon_info])
        .build(tauri::generate_context!())
        .expect("error while building crew")
        // Quit exits the process without dropping managed state, so the shells
        // would only learn from a closed master fd and claude could linger.
        .run(|app, event| {
            if let RunEvent::Exit = event {
                app.state::<PtyHost>().kill_all();
                app.state::<AgentHost>().kill_all();
                app.state::<Bridge>().shutdown();
                app.state::<Handle>().shutdown();
            }
        });
}
