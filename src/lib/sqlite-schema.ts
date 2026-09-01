import type {
    DatabaseSync,
} from "node:sqlite";

import {
    installAgentEventTriggers,
} from "./agent-event-triggers";

let initialized = false;

export function initializeSqliteSchema(
    db: DatabaseSync
) {
    if (initialized) {
        return;
    }


    /*
      ORDER ACTIVITY
    */

    db.exec(`
    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      webhook_id TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL,
      order_name TEXT NOT NULL,
      order_id INTEGER NOT NULL,
      total TEXT,
      currency TEXT,
      payment_status TEXT,
      fulfillment_status TEXT,
      created_at TEXT NOT NULL
    )
  `);

    /*
      ORDER APPROVALS
    */

    db.exec(`
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      order_name TEXT NOT NULL,
      order_id INTEGER NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at TEXT NOT NULL,
      decided_at TEXT
    )
  `);

    /*
      INVENTORY ALERTS
    */

    db.exec(`
    CREATE TABLE IF NOT EXISTS inventory_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inventory_item_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,
      available INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT
    )
  `);

    /*
      INVENTORY APPROVALS
    */

    db.exec(`
    CREATE TABLE IF NOT EXISTS inventory_approvals (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      inventory_alert_id INTEGER NOT NULL,
      inventory_item_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,
      available INTEGER NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at TEXT NOT NULL,
      decided_at TEXT,
      UNIQUE(inventory_alert_id, action)
    )
  `);

    /*
      RESTOCK TASKS
    */

    db.exec(`
    CREATE TABLE IF NOT EXISTS restock_tasks (
      id TEXT PRIMARY KEY,

      inventory_approval_id TEXT UNIQUE NOT NULL,
      inventory_alert_id INTEGER NOT NULL,

      inventory_item_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,

      available_when_approved INTEGER NOT NULL,

      status TEXT NOT NULL DEFAULT 'RESTOCK_APPROVED',

      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )
  `);

    /*
      INVENTORY RECEIPTS
    */

    db.exec(`
    CREATE TABLE IF NOT EXISTS inventory_receipts (
      id TEXT PRIMARY KEY,

      restock_task_id TEXT UNIQUE NOT NULL,

      inventory_item_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,

      quantity_received INTEGER NOT NULL,

      stock_before INTEGER,
      stock_after INTEGER,

      idempotency_key TEXT UNIQUE NOT NULL,

      status TEXT NOT NULL DEFAULT 'PROCESSING',

      shopify_adjustment_id TEXT,

      error TEXT,

      created_at TEXT NOT NULL,
      completed_at TEXT
    )
  `);

    /*
      UNIFIED AGENT EVENT LOG
  
      This table records events from all parts
      of the AI Store Manager in one place.
    */

    db.exec(`
    CREATE TABLE IF NOT EXISTS agent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      event_key TEXT UNIQUE NOT NULL,

      source TEXT NOT NULL,
      event_type TEXT NOT NULL,

      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,

      title TEXT NOT NULL,
      message TEXT,

      status TEXT,

      metadata_json TEXT,

      created_at TEXT NOT NULL
    )
  `);

    /*
      INDEXES
    */

    db.exec(`
    CREATE INDEX IF NOT EXISTS
    idx_inventory_alerts_status
    ON inventory_alerts(status)
  `);

    db.exec(`
    CREATE INDEX IF NOT EXISTS
    idx_inventory_approvals_status
    ON inventory_approvals(status)
  `);

    db.exec(`
    CREATE INDEX IF NOT EXISTS
    idx_restock_tasks_status
    ON restock_tasks(status)
  `);

    db.exec(`
    CREATE INDEX IF NOT EXISTS
    idx_inventory_receipts_status
    ON inventory_receipts(status)
  `);

    db.exec(`
    CREATE INDEX IF NOT EXISTS
    idx_agent_events_created_at
    ON agent_events(created_at)
  `);

    db.exec(`
    CREATE INDEX IF NOT EXISTS
    idx_agent_events_entity
    ON agent_events(
      entity_type,
      entity_id
    )
  `);

    db.exec(`
    CREATE INDEX IF NOT EXISTS
    idx_agent_events_source
    ON agent_events(source)
  `);

    /*
      BACKFILL APPROVED RESTOCK TASKS
    */

    db.exec(`
    INSERT OR IGNORE INTO restock_tasks (
      id,
      inventory_approval_id,
      inventory_alert_id,
      inventory_item_id,
      location_id,
      available_when_approved,
      status,
      created_at,
      updated_at,
      completed_at
    )

    SELECT
      'restock-' || id,
      id,
      inventory_alert_id,
      inventory_item_id,
      location_id,
      available,
      'RESTOCK_APPROVED',
      COALESCE(decided_at, created_at),
      COALESCE(decided_at, created_at),
      NULL

    FROM inventory_approvals

    WHERE status = 'APPROVED'
  `);

    /*
      ----------------------------------
      AGENT EVENT HISTORY BACKFILL
      ----------------------------------
    */

    /*
      ORDER WEBHOOK EVENTS
    */

    db.exec(`
    INSERT OR IGNORE INTO agent_events (
      event_key,
      source,
      event_type,
      entity_type,
      entity_id,
      title,
      message,
      status,
      metadata_json,
      created_at
    )

    SELECT
      'order-webhook:' || webhook_id,

      'SHOPIFY',

      type,

      'ORDER',

      CAST(order_id AS TEXT),

      CASE
        WHEN type = 'NEW_ORDER'
          THEN 'New order received'

        WHEN type = 'NEEDS_FULFILLMENT'
          THEN 'Order needs fulfillment'

        ELSE 'Order event'
      END,

      order_name ||
      ' - ' ||
      COALESCE(total, '') ||
      ' ' ||
      COALESCE(currency, ''),

      fulfillment_status,

      json_object(
        'orderName',
        order_name,

        'total',
        total,

        'currency',
        currency,

        'paymentStatus',
        payment_status,

        'fulfillmentStatus',
        fulfillment_status
      ),

      created_at

    FROM activity
  `);

    /*
      ORDER APPROVAL CREATED
    */

    db.exec(`
    INSERT OR IGNORE INTO agent_events (
      event_key,
      source,
      event_type,
      entity_type,
      entity_id,
      title,
      message,
      status,
      metadata_json,
      created_at
    )

    SELECT
      'order-approval-created:' || id,

      'APPROVAL',

      'ORDER_APPROVAL_CREATED',

      'ORDER',

      CAST(order_id AS TEXT),

      'Fulfillment review created',

      reason,

      'PENDING',

      json_object(
        'approvalId',
        id,

        'action',
        action,

        'orderName',
        order_name
      ),

      created_at

    FROM approvals
  `);

    /*
      ORDER APPROVAL DECISION
    */

    db.exec(`
    INSERT OR IGNORE INTO agent_events (
      event_key,
      source,
      event_type,
      entity_type,
      entity_id,
      title,
      message,
      status,
      metadata_json,
      created_at
    )

    SELECT
      'order-approval-decided:' || id,

      'APPROVAL',

      CASE
        WHEN status = 'APPROVED'
          THEN 'ORDER_APPROVAL_APPROVED'

        WHEN status = 'REJECTED'
          THEN 'ORDER_APPROVAL_REJECTED'

        ELSE 'ORDER_APPROVAL_DECIDED'
      END,

      'ORDER',

      CAST(order_id AS TEXT),

      CASE
        WHEN status = 'APPROVED'
          THEN 'Fulfillment review approved'

        WHEN status = 'REJECTED'
          THEN 'Fulfillment review rejected'

        ELSE 'Fulfillment review decided'
      END,

      reason,

      status,

      json_object(
        'approvalId',
        id,

        'action',
        action,

        'orderName',
        order_name
      ),

      decided_at

    FROM approvals

    WHERE
      status != 'PENDING'
      AND decided_at IS NOT NULL
  `);

    /*
      LOW INVENTORY ALERT CREATED
    */

    db.exec(`
    INSERT OR IGNORE INTO agent_events (
      event_key,
      source,
      event_type,
      entity_type,
      entity_id,
      title,
      message,
      status,
      metadata_json,
      created_at
    )

    SELECT
      'inventory-alert-created:' ||
      CAST(id AS TEXT),

      'INVENTORY',

      'LOW_INVENTORY_DETECTED',

      'INVENTORY_ITEM',

      CAST(inventory_item_id AS TEXT),

      'Low inventory detected',

      'Available quantity: ' ||
      CAST(available AS TEXT),

      'OPEN',

      json_object(
        'inventoryAlertId',
        id,

        'inventoryItemId',
        inventory_item_id,

        'locationId',
        location_id,

        'available',
        available
      ),

      created_at

    FROM inventory_alerts
  `);

    /*
      LOW INVENTORY ALERT RESOLVED
    */

    db.exec(`
    INSERT OR IGNORE INTO agent_events (
      event_key,
      source,
      event_type,
      entity_type,
      entity_id,
      title,
      message,
      status,
      metadata_json,
      created_at
    )

    SELECT
      'inventory-alert-resolved:' ||
      CAST(id AS TEXT),

      'INVENTORY',

      'LOW_INVENTORY_RESOLVED',

      'INVENTORY_ITEM',

      CAST(inventory_item_id AS TEXT),

      'Low inventory resolved',

      'Available quantity: ' ||
      CAST(available AS TEXT),

      'RESOLVED',

      json_object(
        'inventoryAlertId',
        id,

        'inventoryItemId',
        inventory_item_id,

        'locationId',
        location_id,

        'available',
        available
      ),

      resolved_at

    FROM inventory_alerts

    WHERE
      status = 'RESOLVED'
      AND resolved_at IS NOT NULL
  `);

    /*
      RESTOCK APPROVAL CREATED
    */

    db.exec(`
    INSERT OR IGNORE INTO agent_events (
      event_key,
      source,
      event_type,
      entity_type,
      entity_id,
      title,
      message,
      status,
      metadata_json,
      created_at
    )

    SELECT
      'inventory-approval-created:' ||
      id,

      'APPROVAL',

      'RESTOCK_REVIEW_CREATED',

      'INVENTORY_ITEM',

      CAST(inventory_item_id AS TEXT),

      'Restock review created',

      reason,

      'PENDING',

      json_object(
        'approvalId',
        id,

        'inventoryAlertId',
        inventory_alert_id,

        'available',
        available,

        'locationId',
        location_id
      ),

      created_at

    FROM inventory_approvals
  `);

    /*
      RESTOCK APPROVAL DECISION
    */

    db.exec(`
    INSERT OR IGNORE INTO agent_events (
      event_key,
      source,
      event_type,
      entity_type,
      entity_id,
      title,
      message,
      status,
      metadata_json,
      created_at
    )

    SELECT
      'inventory-approval-decided:' ||
      id,

      'APPROVAL',

      CASE
        WHEN status = 'APPROVED'
          THEN 'RESTOCK_REVIEW_APPROVED'

        WHEN status = 'REJECTED'
          THEN 'RESTOCK_REVIEW_REJECTED'

        WHEN status = 'CANCELLED'
          THEN 'RESTOCK_REVIEW_CANCELLED'

        ELSE 'RESTOCK_REVIEW_DECIDED'
      END,

      'INVENTORY_ITEM',

      CAST(inventory_item_id AS TEXT),

      CASE
        WHEN status = 'APPROVED'
          THEN 'Restock review approved'

        WHEN status = 'REJECTED'
          THEN 'Restock review rejected'

        WHEN status = 'CANCELLED'
          THEN 'Restock review cancelled'

        ELSE 'Restock review decided'
      END,

      reason,

      status,

      json_object(
        'approvalId',
        id,

        'inventoryAlertId',
        inventory_alert_id,

        'available',
        available,

        'locationId',
        location_id
      ),

      decided_at

    FROM inventory_approvals

    WHERE
      status != 'PENDING'
      AND decided_at IS NOT NULL
  `);

    /*
      RESTOCK TASK CREATED
    */

    db.exec(`
    INSERT OR IGNORE INTO agent_events (
      event_key,
      source,
      event_type,
      entity_type,
      entity_id,
      title,
      message,
      status,
      metadata_json,
      created_at
    )

    SELECT
      'restock-task-created:' ||
      id,

      'TASK',

      'RESTOCK_TASK_CREATED',

      'INVENTORY_ITEM',

      CAST(inventory_item_id AS TEXT),

      'Restock task created',

      'Inventory when approved: ' ||
      CAST(
        available_when_approved
        AS TEXT
      ),

      status,

      json_object(
        'restockTaskId',
        id,

        'inventoryApprovalId',
        inventory_approval_id,

        'inventoryAlertId',
        inventory_alert_id,

        'locationId',
        location_id
      ),

      created_at

    FROM restock_tasks
  `);

    /*
      RESTOCK TASK COMPLETED
    */

    db.exec(`
    INSERT OR IGNORE INTO agent_events (
      event_key,
      source,
      event_type,
      entity_type,
      entity_id,
      title,
      message,
      status,
      metadata_json,
      created_at
    )

    SELECT
      'restock-task-completed:' ||
      id,

      'TASK',

      'RESTOCK_TASK_COMPLETED',

      'INVENTORY_ITEM',

      CAST(inventory_item_id AS TEXT),

      'Restock task completed',

      'Inventory was received successfully.',

      'COMPLETED',

      json_object(
        'restockTaskId',
        id,

        'inventoryApprovalId',
        inventory_approval_id,

        'inventoryAlertId',
        inventory_alert_id,

        'locationId',
        location_id
      ),

      completed_at

    FROM restock_tasks

    WHERE
      status = 'COMPLETED'
      AND completed_at IS NOT NULL
  `);

    /*
      INVENTORY RECEIVED
    */

    db.exec(`
    INSERT OR IGNORE INTO agent_events (
      event_key,
      source,
      event_type,
      entity_type,
      entity_id,
      title,
      message,
      status,
      metadata_json,
      created_at
    )

    SELECT
      'inventory-receipt:' ||
      id,

      'SHOPIFY',

      'INVENTORY_RECEIVED',

      'INVENTORY_ITEM',

      CAST(inventory_item_id AS TEXT),

      'Inventory received',

      CAST(quantity_received AS TEXT) ||
      ' units received. Stock changed from ' ||
      CAST(stock_before AS TEXT) ||
      ' to ' ||
      CAST(stock_after AS TEXT),

      status,

      json_object(
        'receiptId',
        id,

        'restockTaskId',
        restock_task_id,

        'quantityReceived',
        quantity_received,

        'stockBefore',
        stock_before,

        'stockAfter',
        stock_after,

        'locationId',
        location_id,

        'shopifyAdjustmentId',
        shopify_adjustment_id
      ),

      COALESCE(
        completed_at,
        created_at
      )

    FROM inventory_receipts
  `);

    installAgentEventTriggers(db);
    initialized = true;
}
