//! The desktop shell. Business logic lives in TypeScript; this side only owns the
//! SQLite file and (later) the printer and cash drawer.

mod db;

use db::{Database, ExecResult};
use serde_json::Value;
use tauri::{Manager, State};

/// Runs one SQL statement. Called for every query the app makes.
#[tauri::command]
async fn db_execute(
    db: State<'_, Database>,
    sql: String,
    params: Vec<Value>,
) -> Result<ExecResult, String> {
    db.execute(&sql, &params)
}

/// Rolls back a transaction left open by a previous page load (e.g. a webview reload).
#[tauri::command]
async fn db_reset(db: State<'_, Database>) -> Result<(), String> {
    db.reset()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let database = Database::open(&dir.join("till.db"))?;
            app.manage(database);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![db_execute, db_reset])
        .run(tauri::generate_context!())
        .expect("error while running the till");
}
