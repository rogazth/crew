mod agent;
mod files;
mod menu;
mod pty;
mod session;
mod store;
mod workspace;

use tauri::{Manager, RunEvent};

use agent::AgentHost;
use pty::PtyHost;
use store::Store;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.set_menu(menu::build(app)?)?;
            let dir = app.path().app_data_dir()?;
            app.manage(Store::open(dir.join("crew.sqlite3"))?);
            app.manage(PtyHost::new());
            app.manage(AgentHost::new());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            workspace::workspace_list,
            workspace::workspace_create,
            workspace::workspace_rename,
            workspace::workspace_delete,
            workspace::workspace_reorder,
            workspace::active_workspace_get,
            workspace::active_workspace_set,
            session::session_list,
            session::session_create,
            session::session_update,
            session::session_rename,
            session::session_delete,
            session::session_reorder,
            session::session_set_status,
            session::session_get_blocks,
            session::session_set_blocks,
            session::session_set_provider_session,
            store::state_get,
            store::state_set,
            files::list_project_files,
            files::read_text_file,
            files::write_text_file,
            files::path_exists,
            files::write_temp_file,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            agent::agent_resolve_claude,
            agent::agent_spawn,
            agent::agent_write,
            agent::agent_kill,
        ])
        .build(tauri::generate_context!())
        .expect("error while building crew")
        // Quit exits the process without dropping managed state, so the shells
        // would only learn from a closed master fd and claude could linger.
        .run(|app, event| {
            if let RunEvent::Exit = event {
                app.state::<PtyHost>().kill_all();
                app.state::<AgentHost>().kill_all();
            }
        });
}
