export interface Migration {
  /** Sortable and never renamed once released, e.g. "0002-suppliers". */
  id: string;
  /** Run in order inside one transaction. One statement per string. */
  statements: string[];
}
