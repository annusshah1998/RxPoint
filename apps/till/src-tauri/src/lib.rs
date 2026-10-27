//! The desktop shell. Business logic lives in TypeScript; this side owns the SQLite
//! file, backups, the receipt printer and the webview's settings.

mod backup;
mod db;
mod printer;
#[cfg(windows)]
mod webview;

use backup::{BackupCheck, BackupFile};
use db::{Database, ExecResult};
use printer::{PrintTarget, PrinterInfo};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
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

/// The backups folder, or another folder the person typed (the mirror, e.g. a USB
/// drive), which must exist (`backup::other_dir`).
fn folder(backups: &Path, dir: Option<&str>) -> Result<PathBuf, String> {
    dir.map_or_else(
        || Ok(backups.to_path_buf()),
        |d| backup::other_dir(d, backups),
    )
}

/// Lists the backups folder, or another folder (e.g. the copy on a USB drive).
#[tauri::command]
async fn backup_list(
    paths: State<'_, Paths>,
    dir: Option<String>,
) -> Result<Vec<BackupFile>, String> {
    let backups = paths.backup_dir.clone();
    blocking(move || backup::list(&folder(&backups, dir.as_deref())?)).await
}

#[tauri::command]
async fn backup_delete(
    paths: State<'_, Paths>,
    name: String,
    dir: Option<String>,
) -> Result<(), String> {
    let backups = paths.backup_dir.clone();
    blocking(move || backup::delete(&folder(&backups, dir.as_deref())?, &name)).await
}

#[tauri::command]
async fn backup_copy(
    paths: State<'_, Paths>,
    name: String,
    dest_dir: String,
) -> Result<(), String> {
    let backups = paths.backup_dir.clone();
    blocking(move || {
        let dest = backup::other_dir(&dest_dir, &backups)?;
        backup::copy_to(&backups, &name, &dest)
    })
    .await
}

/// [Test folder]: creates the folder on a connected drive and checks it can be written.
#[tauri::command]
async fn folder_check(paths: State<'_, Paths>, path: String) -> Result<(), String> {
    let backups = paths.backup_dir.clone();
    blocking(move || backup::prepare_folder(&path, &backups).map(|_| ())).await
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
            // So a stray F5, Ctrl+R or Ctrl+P can't reload or print the page mid-sale.
            #[cfg(windows)]
            webview::turn_off_browser_keys(app);
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
