mod menu;

use tauri::{Manager, RunEvent};

use crew_core::agent::{self, AgentHost};
use crew_core::bridge::{self, Bridge};
use crew_core::files;
use crew_core::pty::{self, PtyHost};
use crew_core::routine;
use crew_core::session;
use crew_core::store::{self, Store};
use crew_core::workspace;
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
            let pty = PtyHost::new();
            let daemon = serve(Config { pty: pty.clone() }).map_err(|e| e.to_string())?;
            app.manage(Store::open(dir.join("crew.sqlite3"))?);
            app.manage(pty);
            app.manage(AgentHost::new());
            app.manage(Bridge::start(app.handle().clone(), dir)?);
            app.manage(daemon);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            daemon_info,
            workspace::workspace_list,
            workspace::workspace_create,
            workspace::workspace_rename,
            workspace::workspace_delete,
            workspace::workspace_reorder,
            workspace::active_workspace_get,
            workspace::active_workspace_set,
            session::session_list,
            session::session_get,
            session::session_create,
            session::session_update,
            session::session_rename,
            session::session_delete,
            session::session_reorder,
            session::session_set_status,
            session::session_get_blocks,
            session::session_set_blocks,
            session::session_set_provider_session,
            routine::routine_list_for_session,
            routine::routine_list,
            routine::routine_upsert,
            routine::routine_delete,
            routine::routine_mark_run,
            store::state_get,
            store::state_set,
            files::list_project_files,
            files::read_text_file,
            files::write_text_file,
            files::path_exists,
            files::write_temp_file,
            files::read_file_base64,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_ack,
            pty::pty_kill,
            agent::agent_resolve_claude,
            agent::agent_resolve,
            agent::agent_spawn,
            agent::agent_write,
            agent::agent_close_stdin,
            agent::agent_kill,
            agent::agent_kill_all,
            agent::agent_running,
            bridge::bridge_info,
            bridge::bridge_reply,
        ])
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
