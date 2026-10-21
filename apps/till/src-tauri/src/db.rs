//! One SQLite connection, shared behind a mutex. The TypeScript side serialises
//! access and drives transactions (BEGIN/COMMIT arrive as ordinary statements), so
//! this layer only has to run single statements and convert values.

use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params_from_iter, Connection};
use serde::Serialize;
use serde_json::{Map, Number, Value};
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

pub struct Database {
    conn: Mutex<Connection>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub rows: Vec<Map<String, Value>>,
    pub changes: u64,
    pub last_insert_rowid: Option<i64>,
}

impl Database {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        // WAL keeps reads fast while writing and survives crashes well.
        conn.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))?;
        Self::configure(conn)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> rusqlite::Result<Self> {
        Self::configure(Connection::open_in_memory()?)
    }

    fn configure(conn: Connection) -> rusqlite::Result<Self> {
        // FULL: a committed sale must survive a power cut (load-shedding is common).
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(Duration::from_secs(5))?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Runs a single statement with positional parameters.
    pub fn execute(&self, sql: &str, params: &[Value]) -> Result<ExecResult, String> {
        let conn = self.conn.lock().map_err(|_| "database lock poisoned")?;
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
        let conn = self.conn.lock().map_err(|_| "database lock poisoned")?;
        if !conn.is_autocommit() {
            conn.execute_batch("ROLLBACK").map_err(|e| e.to_string())?;
        }
        Ok(())
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
