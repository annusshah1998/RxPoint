// SQL snippets shared by migrations from 0002 on. (0001 has its own copies and is never edited.)

export const appendOnly = (table: string): string[] => [
  `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
   BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END`,
  `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
   BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END`,
];

export const bool = (column: string) => `${column} INTEGER NOT NULL CHECK (${column} IN (0, 1))`;

/** A 'YYYY-MM-DD' column check. */
export const isDate = (column: string) =>
  `${column} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'`;
