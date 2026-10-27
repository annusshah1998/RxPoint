//! Backup files of the till database.
//!
//! A backup is made with `VACUUM INTO` from a second, read-only connection. In WAL mode
//! that reads a consistent snapshot of committed data while the till keeps working,
//! so a backup never blocks a sale. Each copy is written as `<name>.partial`, synced to
//! disk, integrity-checked, and only then renamed to its final name.
//!
//! Commands take file NAMES (checked by `check_name`), never paths, for files inside
//! the backups folder. A second folder (the mirror: a USB stick or another drive) is
//! given as a path the person typed; `other_dir` and `prepare_folder` check it.

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Component, Path, PathBuf};
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

/// Opens with write access: on Windows `sync_all` (FlushFileBuffers) is denied on a
/// read-only handle.
fn sync_file(path: &Path) -> Result<(), String> {
    OpenOptions::new()
        .write(true)
        .open(path)
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
/// `dest_dir` must already be checked by `other_dir`; it is never created here.
pub fn copy_to(dir: &Path, name: &str, dest_dir: &Path) -> Result<(), String> {
    let source = path_in(dir, name)?;
    // A stick pulled out mid-copy leaves a .partial behind; tidy those first.
    cleanup(dest_dir);
    let target = dest_dir.join(name);
    let partial = partial_path(&target);
    fs::copy(&source, &partial).map_err(|e| format!("Could not copy the backup: {e}"))?;
    sync_file(&partial)?;
    fs::rename(&partial, &target).map_err(|e| format!("Could not finish the copy: {e}"))
}

/// The drive part of a full path: `E:\` on Windows, `\\server\share\` for a network
/// share, `/` elsewhere.
fn drive_root(path: &Path) -> Option<PathBuf> {
    let mut root = PathBuf::new();
    for part in path.components() {
        match part {
            Component::Prefix(_) | Component::RootDir => root.push(part.as_os_str()),
            _ => break,
        }
    }
    (!root.as_os_str().is_empty()).then_some(root)
}

/// A folder path as typed: it must be a full path on a drive that is connected.
fn typed_folder(path: &str) -> Result<PathBuf, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("Type the folder's full path, such as E:\\TillBackups".into());
    }
    let typed = PathBuf::from(path);
    if !typed.is_absolute() {
        return Err(format!(
            "Type the folder's full path, such as E:\\TillBackups (not {path})"
        ));
    }
    if let Some(root) = drive_root(&typed) {
        if !root.exists() {
            return Err(format!(
                "The backup drive {} is not connected",
                root.display()
            ));
        }
    }
    Ok(typed)
}

/// A folder outside the backups folder (the mirror), as the person typed it. It must be a
/// full path to an existing folder; the result is canonicalised, so `..` and links can't
/// lead somewhere else, and it can't be the backups folder or inside it.
pub fn other_dir(path: &str, backups: &Path) -> Result<PathBuf, String> {
    let typed = typed_folder(path)?;
    let shown = typed.display();
    match fs::metadata(&typed) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => return Err(format!("{shown} is a file, not a folder")),
        Err(e) if e.kind() == ErrorKind::NotFound => {
            return Err(format!("The folder {shown} does not exist"))
        }
        Err(e) => return Err(format!("Could not open the folder {shown}: {e}")),
    }
    let dir =
        fs::canonicalize(&typed).map_err(|e| format!("Could not open the folder {shown}: {e}"))?;
    if fs::canonicalize(backups).is_ok_and(|own| dir.starts_with(own)) {
        return Err(
            "That is the till's own backups folder. Choose a USB stick or another drive.".into(),
        );
    }
    Ok(dir)
}

/// Gets a mirror folder ready ([Test folder]): creates it if the drive is connected but
/// the folder is missing, then checks that a file can be written and synced there.
pub fn prepare_folder(path: &str, backups: &Path) -> Result<PathBuf, String> {
    let typed = typed_folder(path)?;
    if !typed.exists() {
        fs::create_dir_all(&typed)
            .map_err(|e| format!("Could not create the folder {}: {e}", typed.display()))?;
    }
    let dir = other_dir(path, backups)?;
    let probe = dir.join(".write-test");
    let written = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&probe)
        .and_then(|mut f| {
            f.write_all(b"ok")?;
            f.sync_all()
        });
    let _ = fs::remove_file(&probe);
    written.map_err(|e| format!("Cannot write to {}: {e}", typed.display()))?;
    Ok(dir)
}

/// Removes leftovers from interrupted backups and copies (`till-….db.partial` only, as
/// a mirror folder may hold other files).
pub fn cleanup(dir: &Path) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name
                .strip_suffix(".partial")
                .is_some_and(|stem| check_name(stem).is_ok())
            {
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

        let usb = prepare_folder(text(&usb), &dir).unwrap();
        // A copy cut off by pulling the stick out is tidied up by the next one.
        fs::write(usb.join("till-1-auto.db.partial"), "half").unwrap();
        fs::write(usb.join("holiday.jpg.partial"), "not ours").unwrap();
        copy_to(&dir, "till-2-auto.db", &usb).unwrap();
        assert!(verify(&usb.join("till-2-auto.db")).unwrap().integrity_ok);
        assert!(!usb.join("till-1-auto.db.partial").exists());
        assert!(usb.join("holiday.jpg.partial").exists());
        let mirrored: Vec<_> = list(&usb).unwrap().into_iter().map(|f| f.name).collect();
        assert_eq!(mirrored, vec!["till-2-auto.db"]);

        delete(&usb, "till-2-auto.db").unwrap();
        delete(&dir, "till-1-auto.db").unwrap();
        assert_eq!(list(&dir).unwrap().len(), 1);
        assert!(list(&usb).unwrap().is_empty());
        assert!(delete(&dir, "../till.db").is_err());
    }

    fn text(path: &Path) -> &str {
        path.to_str().unwrap()
    }

    #[test]
    fn a_mirror_folder_must_be_an_existing_folder_given_in_full() {
        let tmp = TempDir::new("dirs");
        let backups = tmp.0.join("backups");
        fs::create_dir_all(&backups).unwrap();
        let usb = tmp.0.join("usb");
        fs::create_dir_all(&usb).unwrap();

        // Canonicalised: a detour through `..` ends at the same folder.
        let detour = tmp.0.join("backups").join("..").join("usb");
        assert_eq!(
            other_dir(text(&detour), &backups).unwrap(),
            fs::canonicalize(&usb).unwrap()
        );
        assert_eq!(
            other_dir(&format!("  {}  ", text(&usb)), &backups).unwrap(),
            fs::canonicalize(&usb).unwrap(),
            "spaces around a typed path are ignored"
        );

        let missing = tmp.0.join("nowhere");
        let err = other_dir(text(&missing), &backups).unwrap_err();
        assert_eq!(
            err,
            format!("The folder {} does not exist", missing.display())
        );
        assert!(!missing.exists(), "never created by a copy, list or delete");

        let file = tmp.0.join("notes.txt");
        fs::write(&file, "x").unwrap();
        assert_eq!(
            other_dir(text(&file), &backups).unwrap_err(),
            format!("{} is a file, not a folder", file.display())
        );

        for relative in ["usb", "backups", ".", "E:", ""] {
            let err = other_dir(relative, &backups).unwrap_err();
            assert!(
                err.starts_with("Type the folder's full path"),
                "{relative}: {err}"
            );
        }

        for own in [backups.clone(), backups.join("inside")] {
            fs::create_dir_all(&own).unwrap();
            assert!(
                other_dir(text(&own), &backups)
                    .unwrap_err()
                    .contains("the till's own backups folder"),
                "{}",
                own.display()
            );
        }
    }

    #[test]
    fn test_folder_creates_a_missing_folder_but_not_on_a_file() {
        let tmp = TempDir::new("prepare");
        let backups = tmp.0.join("backups");
        fs::create_dir_all(&backups).unwrap();

        let fresh = tmp.0.join("stick").join("TillBackups");
        let dir = prepare_folder(text(&fresh), &backups).unwrap();
        assert!(fresh.is_dir());
        assert_eq!(dir, fs::canonicalize(&fresh).unwrap());
        assert!(!fresh.join(".write-test").exists(), "the probe is removed");

        let file = tmp.0.join("notes.txt");
        fs::write(&file, "x").unwrap();
        assert!(prepare_folder(text(&file), &backups)
            .unwrap_err()
            .ends_with("is a file, not a folder"));
        assert!(prepare_folder(text(&backups), &backups).is_err());
        assert!(prepare_folder("TillBackups", &backups).is_err());
        assert!(
            !Path::new("TillBackups").exists(),
            "nothing made beside the app"
        );
    }

    /// A drive letter with nothing behind it, as when the USB stick is out.
    #[cfg(windows)]
    #[test]
    fn a_missing_drive_says_it_is_not_connected() {
        let tmp = TempDir::new("drive");
        let Some(letter) = (b'D'..=b'Z')
            .rev()
            .map(char::from)
            .find(|l| !Path::new(&format!("{l}:\\")).exists())
        else {
            return; // every letter is taken on this machine
        };
        let path = format!("{letter}:\\TillBackups");
        let expected = format!("The backup drive {letter}:\\ is not connected");
        assert_eq!(other_dir(&path, &tmp.0).unwrap_err(), expected);
        assert_eq!(prepare_folder(&path, &tmp.0).unwrap_err(), expected);
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
