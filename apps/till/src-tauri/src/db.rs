//! One SQLite connection, shared behind a mutex. The TypeScript side serialises
//! access and drives transactions (BEGIN/COMMIT arrive as ordinary statements), so
//! this layer only has to run single statements and convert values.

use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params_from_iter, Connection};
use serde::Serialize;
use serde_json::{Map, Number, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

pub struct Database {
    /// The database file; None for in-memory test databases.
    path: Option<PathBuf>,
    /// None when the file could not be opened (see `open_error`), so the app can
    /// still start and offer a restore instead of crashing.
    conn: Mutex<Option<Connection>>,
    open_error: Mutex<Option<String>>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub rows: Vec<Map<String, Value>>,
    pub changes: u64,
    pub last_insert_rowid: Option<i64>,
}

fn open_file(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    // WAL keeps reads fast while writing and survives crashes well.
    conn.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))?;
    configure(&conn)?;
    Ok(conn)
}

fn configure(conn: &Connection) -> rusqlite::Result<()> {
    // FULL: a committed sale must survive a power cut (load-shedding is common).
    conn.pragma_update(None, "synchronous", "FULL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(Duration::from_secs(5))?;
    Ok(())
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut p = path.as_os_str().to_owned();
    p.push(suffix);
    PathBuf::from(p)
}

impl Database {
    /// Opens the database file. Never fails: if the file can't be opened, every query
    /// returns the reason, and the app shows it with a way to restore a backup.
    pub fn open(path: &Path) -> Self {
        let (conn, error) = match open_file(path) {
            Ok(conn) => (Some(conn), None),
            Err(e) => (None, Some(e.to_string())),
        };
        Self {
            path: Some(path.to_path_buf()),
            conn: Mutex::new(conn),
            open_error: Mutex::new(error),
        }
    }

    #[cfg(test)]
    pub fn open_in_memory() -> rusqlite::Result<Self> {
        let conn = Connection::open_in_memory()?;
        configure(&conn)?;
        Ok(Self {
            path: None,
            conn: Mutex::new(Some(conn)),
            open_error: Mutex::new(None),
        })
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    fn lock(&self) -> Result<MutexGuard<'_, Option<Connection>>, String> {
        self.conn
            .lock()
            .map_err(|_| "database lock poisoned".to_string())
    }

    fn not_open(&self) -> String {
        let reason = self
            .open_error
            .lock()
            .ok()
            .and_then(|e| e.clone())
            .unwrap_or_else(|| "unknown error".into());
        format!("The database could not be opened: {reason}")
    }

    /// Runs a single statement with positional parameters.
    pub fn execute(&self, sql: &str, params: &[Value]) -> Result<ExecResult, String> {
        let guard = self.lock()?;
        let conn = guard.as_ref().ok_or_else(|| self.not_open())?;
        let values = params.iter().map(to_sql).collect::<Result<Vec<_>, _>>()?;
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;

        if stmt.column_count() == 0 {
            let changes = stmt
                .execute(params_from_iter(values.iter()))
                .map_err(|e| e.to_string())?;
            return Ok(ExecResult {
                rows: Vec::new(),
                changes: changes as u64,
                last_insert_rowid: Some(conn.last_insert_rowid()),
            });
        }

        let names: Vec<String> = stmt.column_names().into_iter().map(String::from).collect();
        let readonly = stmt.readonly();
        let mut out = Vec::new();
        let mut rows = stmt
            .query(params_from_iter(values.iter()))
            .map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let mut object = Map::with_capacity(names.len());
            for (i, name) in names.iter().enumerate() {
                let value = row.get_ref(i).map_err(|e| e.to_string())?;
                object.insert(name.clone(), from_sql(value));
            }
            out.push(object);
        }
        drop(rows);
        Ok(ExecResult {
            rows: out,
            // INSERT ... RETURNING returns rows and changes data.
            changes: if readonly { 0 } else { conn.changes() },
            last_insert_rowid: None,
        })
    }

    /// Rolls back an open transaction, if any.
    pub fn reset(&self) -> Result<(), String> {
        let guard = self.lock()?;
        let conn = guard.as_ref().ok_or_else(|| self.not_open())?;
        if !conn.is_autocommit() {
            conn.execute_batch("ROLLBACK").map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Replaces the database with `backup`, after saving the current one to `safety`.
    ///
    /// Order matters: the new file is copied next to the old one first, the connection is
    /// closed (which checkpoints the WAL), stale -wal/-shm files are removed so SQLite can't
    /// replay them onto the restored file, and the new file is renamed into place. A power
    /// cut at any step leaves either the old database or the new one, never a mix.
    pub fn restore_from(&self, backup: &Path, safety: &Path) -> Result<(), String> {
        let path = self
            .path
            .clone()
            .ok_or("No database file to restore into")?;
        let mut guard = self.lock()?;
        if let Some(conn) = guard.as_ref() {
            if !conn.is_autocommit() {
                return Err("The till is busy; try again in a moment".into());
            }
        }
        crate::backup::verify(backup).and_then(|check| {
            if check.integrity_ok {
                Ok(())
            } else {
                Err(format!("That backup is damaged: {}", check.integrity))
            }
        })?;

        // 1. Safety copy of what is about to be replaced.
        let _ = fs::remove_file(safety);
        match guard.as_ref() {
            Some(conn) => {
                let safety_text = safety.to_str().ok_or("Backup path is not valid text")?;
                conn.execute("VACUUM INTO ?1", [safety_text])
                    .map_err(|e| format!("Could not save a safety copy: {e}"))?;
            }
            None if path.exists() => {
                fs::copy(&path, safety)
                    .map_err(|e| format!("Could not save a safety copy: {e}"))?;
            }
            None => {}
        }

        // 2. Stage the backup beside the live file.
        let staged = sidecar(&path, ".restoring");
        fs::copy(backup, &staged).map_err(|e| format!("Could not copy the backup: {e}"))?;
        fs::File::open(&staged)
            .and_then(|f| f.sync_all())
            .map_err(|e| format!("Could not copy the backup: {e}"))?;

        // 3. Close, clear the WAL, swap, reopen.
        if let Some(conn) = guard.take() {
            if let Err((conn, e)) = conn.close() {
                *guard = Some(conn);
                let _ = fs::remove_file(&staged);
                return Err(format!("Could not close the database: {e}"));
            }
        }
        for suffix in ["-wal", "-shm"] {
            let _ = fs::remove_file(sidecar(&path, suffix));
        }
        let swapped = fs::rename(&staged, &path);
        match open_file(&path) {
            Ok(conn) => {
                *guard = Some(conn);
                if let Ok(mut e) = self.open_error.lock() {
                    *e = None;
                }
            }
            Err(e) => {
                if let Ok(mut err) = self.open_error.lock() {
                    *err = Some(e.to_string());
                }
                return Err(format!("The restored database could not be opened: {e}"));
            }
        }
        swapped.map_err(|e| format!("Could not put the backup in place: {e}"))
    }
}

fn to_sql(value: &Value) -> Result<SqlValue, String> {
    Ok(match value {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(i64::from(*b)),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqlValue::Integer(i)
            } else if let Some(f) = n.as_f64() {
                SqlValue::Real(f)
            } else {
                return Err(format!("number out of range: {n}"));
            }
        }
        Value::String(s) => SqlValue::Text(s.clone()),
        // Not used by the app today; store as JSON text rather than fail.
        Value::Array(_) | Value::Object(_) => SqlValue::Text(value.to_string()),
    })
}

fn from_sql(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
        ValueRef::Real(f) => Number::from_f64(f).map_or(Value::Null, Value::Number),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Value::Array(b.iter().map(|byte| Value::from(*byte)).collect()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn db() -> Database {
        let db = Database::open_in_memory().unwrap();
        db.execute(
            "CREATE TABLE item (id TEXT PRIMARY KEY, qty INTEGER NOT NULL, note TEXT) STRICT",
            &[],
        )
        .unwrap();
        db
    }

    fn rows(db: &Database, sql: &str) -> Vec<Map<String, Value>> {
        db.execute(sql, &[]).unwrap().rows
    }

    #[test]
    fn inserts_and_selects_with_parameters() {
        let db = db();
        let insert = db
            .execute(
                "INSERT INTO item VALUES (?, ?, ?)",
                &[json!("a"), json!(5), json!(null)],
            )
            .unwrap();
        assert_eq!(insert.changes, 1);
        let selected = db
            .execute("SELECT * FROM item WHERE id = ?", &[json!("a")])
            .unwrap();
        assert_eq!(selected.changes, 0);
        assert_eq!(
            Value::Object(selected.rows[0].clone()),
            json!({"id": "a", "qty": 5, "note": null})
        );
    }

    #[test]
    fn converts_booleans_and_rejects_fractions_in_strict_tables() {
        let db = db();
        db.execute("INSERT INTO item VALUES ('b', ?, NULL)", &[json!(true)])
            .unwrap();
        assert_eq!(rows(&db, "SELECT qty FROM item")[0]["qty"], json!(1));
        let err = db
            .execute("INSERT INTO item VALUES ('c', ?, NULL)", &[json!(1.5)])
            .unwrap_err();
        assert!(err.contains("cannot store REAL"), "{err}");
    }

    #[test]
    fn returning_reports_rows_and_changes() {
        let db = db();
        let result = db
            .execute("INSERT INTO item VALUES ('a', 1, NULL) RETURNING id", &[])
            .unwrap();
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.changes, 1);
    }

    #[test]
    fn transactions_span_calls_and_reset_rolls_back() {
        let db = db();
        db.execute("BEGIN IMMEDIATE", &[]).unwrap();
        db.execute("INSERT INTO item VALUES ('a', 1, NULL)", &[])
            .unwrap();
        db.reset().unwrap();
        assert!(rows(&db, "SELECT * FROM item").is_empty());
        // Nothing open now; reset is a no-op.
        db.reset().unwrap();
    }

    #[test]
    fn reports_sql_errors_as_text() {
        let db = db();
        assert!(db.execute("SELEC nonsense", &[]).is_err());
        db.execute("INSERT INTO item VALUES ('a', 1, NULL)", &[])
            .unwrap();
        let err = db
            .execute("INSERT INTO item VALUES ('a', 2, NULL)", &[])
            .unwrap_err();
        assert!(err.contains("UNIQUE"), "{err}");
    }

    /// The schema in packages/db/src/migrations relies on these SQLite features.
    #[test]
    fn bundled_sqlite_has_the_features_the_schema_needs() {
        let db = db();
        db.execute(
            "CREATE VIRTUAL TABLE f USING fts5 (name, tokenize = 'trigram')",
            &[],
        )
        .unwrap();
        db.execute("INSERT INTO f VALUES ('Augmentin 625mg')", &[])
            .unwrap();
        assert_eq!(
            rows(&db, "SELECT name FROM f WHERE f MATCH '\"gment\"'").len(),
            1
        );

        db.execute(
            "INSERT INTO item VALUES ('a', 1, NULL), ('b', 2, NULL)",
            &[],
        )
        .unwrap();
        assert_eq!(
            rows(
                &db,
                "SELECT group_concat(id, '+' ORDER BY qty DESC) AS g FROM item"
            )[0]["g"],
            json!("b+a")
        );
        assert_eq!(
            rows(
                &db,
                "SELECT COUNT(*) AS n FROM item a FULL OUTER JOIN item b ON a.id = b.id"
            )[0]["n"],
            json!(2)
        );
    }
}
