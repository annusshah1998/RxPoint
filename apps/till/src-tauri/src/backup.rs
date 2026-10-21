//! Backup files of the till database.
//!
//! A backup is made with `VACUUM INTO` from a second, read-only connection. In WAL mode
//! that reads a consistent snapshot of committed data while the till keeps working,
//! so a backup never blocks a sale. Each copy is written as `<name>.partial`, synced to
//! disk, integrity-checked, and only then renamed to its final name.
//!
//! Commands take file NAMES (checked by `check_name`), never paths, for files inside
//! the backups folder.

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupCheck {
    pub name: String,
    pub size_bytes: u64,
    pub integrity_ok: bool,
    /// "ok", or the problems SQLite found.
    pub integrity: String,
    pub migrations: Vec<String>,
    pub sale_count: Option<i64>,
    pub last_sale_at: Option<String>,
    pub outbox_seq: Option<i64>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupFile {
    pub name: String,
    pub size_bytes: u64,
    pub modified_ms: u64,
}

/// Backup names look like `till-20261021-140500-auto.db`.
pub fn check_name(name: &str) -> Result<(), String> {
    let valid = name.starts_with("till-")
        && name.ends_with(".db")
        && name.len() <= 64
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.' || c == '_');
    if valid {
        Ok(())
    } else {
        Err(format!("Not a valid backup name: {name}"))
    }
}

fn path_in(dir: &Path, name: &str) -> Result<PathBuf, String> {
    check_name(name)?;
    Ok(dir.join(name))
}

fn partial_path(path: &Path) -> PathBuf {
    let mut p = path.as_os_str().to_owned();
    p.push(".partial");
    PathBuf::from(p)
}

fn sync_file(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|f| f.sync_all())
        .map_err(|e| format!("Could not save the backup to disk: {e}"))
}

/// Copies the live database at `db_path` into `dir/name`.
pub fn create(db_path: &Path, dir: &Path, name: &str) -> Result<BackupCheck, String> {
    let target = path_in(dir, name)?;
    fs::create_dir_all(dir).map_err(|e| format!("Could not create the backups folder: {e}"))?;
    if target.exists() {
        return Err(format!("A backup named {name} already exists"));
    }
    let partial = partial_path(&target);
    let _ = fs::remove_file(&partial);

    {
        let source = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| format!("Could not read the database: {e}"))?;
        source
            .busy_timeout(std::time::Duration::from_secs(10))
            .map_err(|e| e.to_string())?;
        let partial_text = partial
            .to_str()
            .ok_or("The backups folder path is not valid text")?;
        source
            .execute("VACUUM INTO ?1", [partial_text])
            .map_err(|e| format!("Backup failed: {e}"))?;
    }
    sync_file(&partial)?;

    let mut check = verify(&partial)?;
    if !check.integrity_ok {
        let mut bad = target.as_os_str().to_owned();
        bad.push(".bad");
        let _ = fs::rename(&partial, PathBuf::from(bad));
        return Err(format!("The backup failed its check: {}", check.integrity));
    }
    fs::rename(&partial, &target).map_err(|e| format!("Could not finish the backup: {e}"))?;
    check.name = name.to_string();
    Ok(check)
}

/// Opens a backup read-only and reports whether it is sound and what it holds.
pub fn verify(path: &Path) -> Result<BackupCheck, String> {
    let size_bytes = fs::metadata(path)
        .map_err(|e| format!("Backup not found: {e}"))?
        .len();
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("Not a readable database: {e}"))?;
    let problems: Vec<String> = {
        let mut stmt = conn
            .prepare("PRAGMA integrity_check")
            .map_err(|e| format!("Not a readable database: {e}"))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
    };
    let integrity = problems.join("; ");
    let integrity_ok = integrity == "ok";

    let has_table = |table: &str| -> bool {
        conn.query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |_| Ok(()),
        )
        .optional()
        .ok()
        .flatten()
        .is_some()
    };

    let migrations = if has_table("schema_migration") {
        let mut stmt = conn
            .prepare("SELECT id FROM schema_migration ORDER BY id")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
    } else {
        Vec::new()
    };
    let (sale_count, last_sale_at) = if has_table("sale") {
        conn.query_row("SELECT COUNT(*), MAX(created_at) FROM sale", [], |row| {
            Ok((
                Some(row.get::<_, i64>(0)?),
                row.get::<_, Option<String>>(1)?,
            ))
        })
        .map_err(|e| e.to_string())?
    } else {
        (None, None)
    };
    let outbox_seq = if has_table("sync_outbox") {
        conn.query_row("SELECT MAX(seq) FROM sync_outbox", [], |row| {
            row.get::<_, Option<i64>>(0)
        })
        .map_err(|e| e.to_string())?
    } else {
        None
    };

    Ok(BackupCheck {
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        size_bytes,
        integrity_ok,
        integrity,
        migrations,
        sale_count,
        last_sale_at,
        outbox_seq,
    })
}

/// Valid backup files in `dir`, newest first.
pub fn list(dir: &Path) -> Result<Vec<BackupFile>, String> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if check_name(&name).is_err() {
            continue;
        }
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        if !meta.is_file() {
            continue;
        }
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as u64);
        files.push(BackupFile {
            name,
            size_bytes: meta.len(),
            modified_ms,
        });
    }
    files.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(files)
}

pub fn delete(dir: &Path, name: &str) -> Result<(), String> {
    fs::remove_file(path_in(dir, name)?).map_err(|e| format!("Could not delete {name}: {e}"))
}

/// Copies a backup to another folder (e.g. a USB drive), safely: partial file, sync, rename.
pub fn copy_to(dir: &Path, name: &str, dest_dir: &Path) -> Result<(), String> {
    let source = path_in(dir, name)?;
    fs::create_dir_all(dest_dir).map_err(|e| format!("Could not use that folder: {e}"))?;
    let target = dest_dir.join(name);
    let partial = partial_path(&target);
    fs::copy(&source, &partial).map_err(|e| format!("Could not copy the backup: {e}"))?;
    sync_file(&partial)?;
    fs::rename(&partial, &target).map_err(|e| format!("Could not finish the copy: {e}"))
}

/// Checks that a folder exists and can be written to.
pub fn check_folder(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("Could not use that folder: {e}"))?;
    let probe = dir.join(".write-test");
    fs::write(&probe, b"ok")
        .and_then(|_| sync_file(&probe).map_err(std::io::Error::other))
        .map_err(|e| format!("Cannot write to that folder: {e}"))?;
    let _ = fs::remove_file(&probe);
    Ok(())
}

/// Removes leftovers from interrupted backups.
pub fn cleanup(dir: &Path) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().ends_with(".partial") {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use serde_json::json;

    /// A fresh folder per test, removed at the end.
    pub(crate) struct TempDir(pub PathBuf);
    impl TempDir {
        pub fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "till-test-{}-{}-{}",
                std::process::id(),
                label,
                std::time::SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn count(db: &Database) -> i64 {
        db.execute("SELECT COUNT(*) AS n FROM sale", &[])
            .unwrap()
            .rows[0]["n"]
            .as_i64()
            .unwrap()
    }

    fn setup(tmp: &TempDir) -> (Database, PathBuf) {
        let path = tmp.0.join("till.db");
        let db = Database::open(&path);
        db.execute(
            "CREATE TABLE sale (id TEXT PRIMARY KEY, created_at TEXT NOT NULL) STRICT",
            &[],
        )
        .unwrap();
        db.execute(
            "CREATE TABLE schema_migration (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
            &[],
        )
        .unwrap();
        db.execute(
            "INSERT INTO schema_migration VALUES ('0001-initial', 'x')",
            &[],
        )
        .unwrap();
        db.execute("INSERT INTO sale VALUES ('a', '2026-10-21T09:00:00Z')", &[])
            .unwrap();
        (db, path)
    }

    #[test]
    fn names_are_checked() {
        assert!(check_name("till-20261021-140500-auto.db").is_ok());
        for bad in [
            "../till.db",
            "till-x.txt",
            "other.db",
            "till-a/b.db",
            "till-..db",
        ] {
            assert!(check_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn backs_up_only_committed_data_while_a_sale_is_in_progress() {
        let tmp = TempDir::new("backup");
        let (db, path) = setup(&tmp);
        let dir = tmp.0.join("backups");

        db.execute("BEGIN IMMEDIATE", &[]).unwrap();
        db.execute("INSERT INTO sale VALUES ('b', '2026-10-21T10:00:00Z')", &[])
            .unwrap();
        let check = create(&path, &dir, "till-1-auto.db").unwrap();
        db.execute("COMMIT", &[]).unwrap();

        assert!(check.integrity_ok);
        assert_eq!(check.integrity, "ok");
        assert_eq!(check.migrations, vec!["0001-initial".to_string()]);
        assert_eq!(check.sale_count, Some(1));
        assert_eq!(check.last_sale_at.as_deref(), Some("2026-10-21T09:00:00Z"));
        assert_eq!(list(&dir).unwrap().len(), 1);
        assert!(!partial_path(&dir.join("till-1-auto.db")).exists());
        assert!(
            create(&path, &dir, "till-1-auto.db").is_err(),
            "no overwrite"
        );
    }

    #[test]
    fn copies_lists_and_deletes_backups() {
        let tmp = TempDir::new("copy");
        let (_db, path) = setup(&tmp);
        let dir = tmp.0.join("backups");
        let usb = tmp.0.join("usb");
        create(&path, &dir, "till-1-auto.db").unwrap();
        create(&path, &dir, "till-2-auto.db").unwrap();
        fs::write(dir.join("notes.txt"), "ignored").unwrap();

        let names: Vec<_> = list(&dir).unwrap().into_iter().map(|f| f.name).collect();
        assert_eq!(names, vec!["till-2-auto.db", "till-1-auto.db"]);

        check_folder(&usb).unwrap();
        copy_to(&dir, "till-2-auto.db", &usb).unwrap();
        assert!(verify(&usb.join("till-2-auto.db")).unwrap().integrity_ok);

        delete(&dir, "till-1-auto.db").unwrap();
        assert_eq!(list(&dir).unwrap().len(), 1);
        assert!(delete(&dir, "../till.db").is_err());
    }

    #[test]
    fn restores_a_backup_and_keeps_a_safety_copy() {
        let tmp = TempDir::new("restore");
        let (db, path) = setup(&tmp);
        let dir = tmp.0.join("backups");
        create(&path, &dir, "till-1-auto.db").unwrap();
        db.execute("INSERT INTO sale VALUES ('b', '2026-10-21T10:00:00Z')", &[])
            .unwrap();
        assert_eq!(count(&db), 2);

        // Refused while a transaction is open.
        db.execute("BEGIN IMMEDIATE", &[]).unwrap();
        let busy = db.restore_from(&dir.join("till-1-auto.db"), &dir.join("till-safety.db"));
        assert!(busy.unwrap_err().contains("busy"));
        db.execute("ROLLBACK", &[]).unwrap();

        db.restore_from(&dir.join("till-1-auto.db"), &dir.join("till-safety.db"))
            .unwrap();
        assert_eq!(count(&db), 1, "back to the backup");
        let safety = verify(&dir.join("till-safety.db")).unwrap();
        assert_eq!(
            safety.sale_count,
            Some(2),
            "safety copy has what was replaced"
        );

        // The restored database still works normally.
        db.execute("INSERT INTO sale VALUES (?, ?)", &[json!("c"), json!("t")])
            .unwrap();
        assert_eq!(count(&db), 2);
        drop(db);
        assert!(!path.with_extension("db.restoring").exists());
    }

    #[test]
    fn cleanup_removes_partial_files() {
        let tmp = TempDir::new("cleanup");
        fs::write(tmp.0.join("till-1-auto.db.partial"), "x").unwrap();
        fs::write(tmp.0.join("till-2-auto.db"), "x").unwrap();
        cleanup(&tmp.0);
        assert!(!tmp.0.join("till-1-auto.db.partial").exists());
        assert!(tmp.0.join("till-2-auto.db").exists());
    }
}
