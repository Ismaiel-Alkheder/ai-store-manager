import type {
    DatabaseSync,
} from "node:sqlite";

export function ensureFulfillmentSchema(
    db: DatabaseSync
) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS fulfillment_tasks (
      id TEXT PRIMARY KEY,

      order_id TEXT NOT NULL,
      order_gid TEXT NOT NULL,
      order_name TEXT NOT NULL,

      fulfillment_order_id TEXT UNIQUE NOT NULL,

      location_id TEXT,
      location_name TEXT,

      financial_status TEXT NOT NULL,
      order_fulfillment_status TEXT NOT NULL,

      fulfillment_order_status TEXT NOT NULL,
      request_status TEXT,

      remaining_quantity INTEGER NOT NULL,

      line_items_json TEXT NOT NULL,

      status TEXT NOT NULL,

      warning TEXT,

      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,

      completed_at TEXT,

      shopify_fulfillment_id TEXT
    )
  `);

    db.exec(`
    CREATE INDEX IF NOT EXISTS
    idx_fulfillment_tasks_status
    ON fulfillment_tasks(status)
  `);

    db.exec(`
    CREATE INDEX IF NOT EXISTS
    idx_fulfillment_tasks_order
    ON fulfillment_tasks(order_id)
  `);
}