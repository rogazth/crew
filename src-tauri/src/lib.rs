mod files;
mod menu;
mod session;
mod store;
mod workspace;

use tauri::Manager;

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
            store::state_get,
            store::state_set,
            files::list_project_files,
            files::read_text_file,
            files::write_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running crew");
}
