//! The desktop shell. Business logic lives in TypeScript; this side owns the SQLite
//! file, backups and the receipt printer.

mod backup;
mod db;
mod printer;

use backup::{BackupCheck, BackupFile};
use db::{Database, ExecResult};
use printer::{PrintTarget, PrinterInfo};
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use tauri::async_runtime::spawn_blocking;
use tauri::{Manager, State};

/// Where this installation keeps its files.
struct Paths {
    data_dir: PathBuf,
    backup_dir: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    data_dir: String,
    backup_dir: String,
    version: String,
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    spawn_blocking(work).await.map_err(|e| e.to_string())?
}

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

#[tauri::command]
fn app_info(app: tauri::AppHandle, paths: State<'_, Paths>) -> AppInfo {
    AppInfo {
        data_dir: paths.data_dir.to_string_lossy().into_owned(),
        backup_dir: paths.backup_dir.to_string_lossy().into_owned(),
        version: app.package_info().version.to_string(),
    }
}

#[tauri::command]
async fn print_raw(target: PrintTarget, bytes: Vec<u8>) -> Result<(), String> {
    blocking(move || printer::print_raw(&target, &bytes)).await
}

#[tauri::command]
async fn printer_list() -> Result<Vec<PrinterInfo>, String> {
    blocking(printer::list_printers).await
}

#[tauri::command]
async fn backup_create(
    db: State<'_, Database>,
    paths: State<'_, Paths>,
    name: String,
) -> Result<BackupCheck, String> {
    let db_path = db.path().ok_or("No database file")?.to_path_buf();
    let dir = paths.backup_dir.clone();
    blocking(move || backup::create(&db_path, &dir, &name)).await
}

#[tauri::command]
async fn backup_verify(paths: State<'_, Paths>, name: String) -> Result<BackupCheck, String> {
    backup::check_name(&name)?;
    let path = paths.backup_dir.join(&name);
    blocking(move || backup::verify(&path)).await
}

/// Lists the backups folder, or another folder (e.g. the copy on a USB drive).
#[tauri::command]
async fn backup_list(
    paths: State<'_, Paths>,
    dir: Option<String>,
) -> Result<Vec<BackupFile>, String> {
    let dir = dir.map_or_else(|| paths.backup_dir.clone(), PathBuf::from);
    blocking(move || backup::list(&dir)).await
}

#[tauri::command]
async fn backup_delete(
    paths: State<'_, Paths>,
    name: String,
    dir: Option<String>,
) -> Result<(), String> {
    let dir = dir.map_or_else(|| paths.backup_dir.clone(), PathBuf::from);
    blocking(move || backup::delete(&dir, &name)).await
}

#[tauri::command]
async fn backup_copy(
    paths: State<'_, Paths>,
    name: String,
    dest_dir: String,
) -> Result<(), String> {
    let dir = paths.backup_dir.clone();
    blocking(move || backup::copy_to(&dir, &name, &PathBuf::from(dest_dir))).await
}

#[tauri::command]
async fn folder_check(path: String) -> Result<(), String> {
    blocking(move || backup::check_folder(&PathBuf::from(path))).await
}

/// Replaces the live database with a backup (after saving a safety copy).
/// The app reloads afterwards so it re-runs migrations on the restored file.
#[tauri::command]
async fn backup_restore(
    db: State<'_, Database>,
    paths: State<'_, Paths>,
    name: String,
    safety_name: String,
) -> Result<(), String> {
    backup::check_name(&name)?;
    backup::check_name(&safety_name)?;
    db.restore_from(
        &paths.backup_dir.join(&name),
        &paths.backup_dir.join(&safety_name),
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let backup_dir = data_dir.join("backups");
            std::fs::create_dir_all(&backup_dir)?;
            backup::cleanup(&backup_dir);
            app.manage(Database::open(&data_dir.join("till.db")));
            app.manage(Paths {
                data_dir,
                backup_dir,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db_execute,
            db_reset,
            app_info,
            print_raw,
            printer_list,
            backup_create,
            backup_verify,
            backup_list,
            backup_delete,
            backup_copy,
            folder_check,
            backup_restore,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the till");
}
