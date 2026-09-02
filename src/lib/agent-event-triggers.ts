import type {
    DatabaseSync,
} from "node:sqlite";

export function installAgentEventTriggers(
    db: DatabaseSync
) {
    /*
      ORDER WEBHOOK
    */

    db.exec(`
    CREATE TRIGGER IF NOT EXISTS
    trg_activity_agent_event

    AFTER INSERT ON activity

    BEGIN

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

      VALUES (
        'order-webhook:' || NEW.webhook_id,

        'SHOPIFY',

        NEW.type,

        'ORDER',

        CAST(
          NEW.order_id AS TEXT
        ),

        CASE

          WHEN NEW.type =
            'NEW_ORDER'
          THEN
            'New order received'

          WHEN NEW.type =
            'NEEDS_FULFILLMENT'
          THEN
            'Order needs fulfillment'

          ELSE
            'Order event'

        END,

        NEW.order_name ||
        ' - ' ||
        COALESCE(
          NEW.total,
          ''
        ) ||
        ' ' ||
        COALESCE(
          NEW.currency,
          ''
        ),

        NEW.fulfillment_status,

        json_object(
          'orderName',
          NEW.order_name,

          'total',
          NEW.total,

          'currency',
          NEW.currency,

          'paymentStatus',
          NEW.payment_status,

          'fulfillmentStatus',
          NEW.fulfillment_status
        ),

        NEW.created_at
      );

    END;
  `);

    /*
      ORDER APPROVAL CREATED
    */

    db.exec(`
    CREATE TRIGGER IF NOT EXISTS
    trg_order_approval_created

    AFTER INSERT ON approvals

    BEGIN

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

      VALUES (
        'order-approval-created:' ||
        NEW.id,

        'APPROVAL',

        'ORDER_APPROVAL_CREATED',

        'ORDER',

        CAST(
          NEW.order_id AS TEXT
        ),

        'Fulfillment review created',

        NEW.reason,

        NEW.status,

        json_object(
          'approvalId',
          NEW.id,

          'action',
          NEW.action,

          'orderName',
          NEW.order_name
        ),

        NEW.created_at
      );

    END;
  `);

    /*
      ORDER APPROVAL DECISION
    */

    db.exec(`
    CREATE TRIGGER IF NOT EXISTS
    trg_order_approval_decision

    AFTER UPDATE OF status
    ON approvals

    WHEN
      OLD.status = 'PENDING'
      AND
      NEW.status != 'PENDING'

    BEGIN

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

      VALUES (
        'order-approval-decided:' ||
        NEW.id,

        'APPROVAL',

        CASE

          WHEN NEW.status =
            'APPROVED'
          THEN
            'ORDER_APPROVAL_APPROVED'

          WHEN NEW.status =
            'REJECTED'
          THEN
            'ORDER_APPROVAL_REJECTED'

          ELSE
            'ORDER_APPROVAL_DECIDED'

        END,

        'ORDER',

        CAST(
          NEW.order_id AS TEXT
        ),

        CASE

          WHEN NEW.status =
            'APPROVED'
          THEN
            'Fulfillment review approved'

          WHEN NEW.status =
            'REJECTED'
          THEN
            'Fulfillment review rejected'

          ELSE
            'Fulfillment review decided'

        END,

        NEW.reason,

        NEW.status,

        json_object(
          'approvalId',
          NEW.id,

          'action',
          NEW.action,

          'orderName',
          NEW.order_name
        ),

        COALESCE(
          NEW.decided_at,
          datetime('now')
        )
      );

    END;
  `);

    /*
      LOW INVENTORY DETECTED
  
      Important:
      NEW.available is captured NOW,
      before it can later become 24 etc.
    */

    db.exec(`
    CREATE TRIGGER IF NOT EXISTS
    trg_inventory_alert_created

    AFTER INSERT ON inventory_alerts

    BEGIN

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

      VALUES (
        'inventory-alert-created:' ||
        CAST(
          NEW.id AS TEXT
        ),

        'INVENTORY',

        'LOW_INVENTORY_DETECTED',

        'INVENTORY_ITEM',

        CAST(
          NEW.inventory_item_id
          AS TEXT
        ),

        'Low inventory detected',

        'Available quantity: ' ||
        CAST(
          NEW.available AS TEXT
        ),

        NEW.status,

        json_object(
          'inventoryAlertId',
          NEW.id,

          'inventoryItemId',
          NEW.inventory_item_id,

          'locationId',
          NEW.location_id,

          'available',
          NEW.available
        ),

        NEW.created_at
      );

    END;
  `);

    /*
      LOW INVENTORY RESOLVED
    */

    db.exec(`
    CREATE TRIGGER IF NOT EXISTS
    trg_inventory_alert_resolved

    AFTER UPDATE OF status
    ON inventory_alerts

    WHEN
      OLD.status = 'OPEN'
      AND
      NEW.status = 'RESOLVED'

    BEGIN

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

      VALUES (
        'inventory-alert-resolved:' ||
        CAST(
          NEW.id AS TEXT
        ),

        'INVENTORY',

        'LOW_INVENTORY_RESOLVED',

        'INVENTORY_ITEM',

        CAST(
          NEW.inventory_item_id
          AS TEXT
        ),

        'Low inventory resolved',

        'Available quantity: ' ||
        CAST(
          NEW.available AS TEXT
        ),

        'RESOLVED',

        json_object(
          'inventoryAlertId',
          NEW.id,

          'inventoryItemId',
          NEW.inventory_item_id,

          'locationId',
          NEW.location_id,

          'available',
          NEW.available
        ),

        COALESCE(
          NEW.resolved_at,
          datetime('now')
        )
      );

    END;
  `);

    /*
      RESTOCK REVIEW CREATED
    */

    db.exec(`
    CREATE TRIGGER IF NOT EXISTS
    trg_inventory_approval_created

    AFTER INSERT
    ON inventory_approvals

    BEGIN

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

      VALUES (
        'inventory-approval-created:' ||
        NEW.id,

        'APPROVAL',

        'RESTOCK_REVIEW_CREATED',

        'INVENTORY_ITEM',

        CAST(
          NEW.inventory_item_id
          AS TEXT
        ),

        'Restock review created',

        NEW.reason,

        NEW.status,

        json_object(
          'approvalId',
          NEW.id,

          'inventoryAlertId',
          NEW.inventory_alert_id,

          'available',
          NEW.available,

          'locationId',
          NEW.location_id
        ),

        NEW.created_at
      );

    END;
  `);

    /*
      RESTOCK REVIEW DECISION
    */

    db.exec(`
    CREATE TRIGGER IF NOT EXISTS
    trg_inventory_approval_decision

    AFTER UPDATE OF status
    ON inventory_approvals

    WHEN
      OLD.status = 'PENDING'
      AND
      NEW.status != 'PENDING'

    BEGIN

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

      VALUES (
        'inventory-approval-decided:' ||
        NEW.id,

        'APPROVAL',

        CASE

          WHEN NEW.status =
            'APPROVED'
          THEN
            'RESTOCK_REVIEW_APPROVED'

          WHEN NEW.status =
            'REJECTED'
          THEN
            'RESTOCK_REVIEW_REJECTED'

          WHEN NEW.status =
            'CANCELLED'
          THEN
            'RESTOCK_REVIEW_CANCELLED'

          ELSE
            'RESTOCK_REVIEW_DECIDED'

        END,

        'INVENTORY_ITEM',

        CAST(
          NEW.inventory_item_id
          AS TEXT
        ),

        CASE

          WHEN NEW.status =
            'APPROVED'
          THEN
            'Restock review approved'

          WHEN NEW.status =
            'REJECTED'
          THEN
            'Restock review rejected'

          WHEN NEW.status =
            'CANCELLED'
          THEN
            'Restock review cancelled'

          ELSE
            'Restock review decided'

        END,

        NEW.reason,

        NEW.status,

        json_object(
          'approvalId',
          NEW.id,

          'inventoryAlertId',
          NEW.inventory_alert_id,

          'available',
          NEW.available,

          'locationId',
          NEW.location_id
        ),

        COALESCE(
          NEW.decided_at,
          datetime('now')
        )
      );

    END;
  `);

    /*
      RESTOCK TASK CREATED
    */

    db.exec(`
    CREATE TRIGGER IF NOT EXISTS
    trg_restock_task_created

    AFTER INSERT ON restock_tasks

    BEGIN

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

      VALUES (
        'restock-task-created:' ||
        NEW.id,

        'TASK',

        'RESTOCK_TASK_CREATED',

        'INVENTORY_ITEM',

        CAST(
          NEW.inventory_item_id
          AS TEXT
        ),

        'Restock task created',

        'Inventory when approved: ' ||
        CAST(
          NEW.available_when_approved
          AS TEXT
        ),

        NEW.status,

        json_object(
          'restockTaskId',
          NEW.id,

          'inventoryApprovalId',
          NEW.inventory_approval_id,

          'inventoryAlertId',
          NEW.inventory_alert_id,

          'locationId',
          NEW.location_id
        ),

        NEW.created_at
      );

    END;
  `);

    /*
      RESTOCK TASK COMPLETED
    */

    db.exec(`
    CREATE TRIGGER IF NOT EXISTS
    trg_restock_task_completed

    AFTER UPDATE OF status
    ON restock_tasks

    WHEN
      OLD.status != 'COMPLETED'
      AND
      NEW.status = 'COMPLETED'

    BEGIN

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

      VALUES (
        'restock-task-completed:' ||
        NEW.id,

        'TASK',

        'RESTOCK_TASK_COMPLETED',

        'INVENTORY_ITEM',

        CAST(
          NEW.inventory_item_id
          AS TEXT
        ),

        'Restock task completed',

        'Inventory was received successfully.',

        'COMPLETED',

        json_object(
          'restockTaskId',
          NEW.id,

          'inventoryApprovalId',
          NEW.inventory_approval_id,

          'inventoryAlertId',
          NEW.inventory_alert_id,

          'locationId',
          NEW.location_id
        ),

        COALESCE(
          NEW.completed_at,
          datetime('now')
        )
      );

    END;
  `);

    /*
      INVENTORY RECEIVED
    */

    db.exec(`
    CREATE TRIGGER IF NOT EXISTS
    trg_inventory_receipt_completed

    AFTER UPDATE OF status
    ON inventory_receipts

    WHEN
      OLD.status != 'COMPLETED'
      AND
      NEW.status = 'COMPLETED'

    BEGIN

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

      VALUES (
        'inventory-receipt:' ||
        NEW.id,

        'SHOPIFY',

        'INVENTORY_RECEIVED',

        'INVENTORY_ITEM',

        CAST(
          NEW.inventory_item_id
          AS TEXT
        ),

        'Inventory received',

        CAST(
          NEW.quantity_received
          AS TEXT
        ) ||
        ' units received. Stock changed from ' ||
        CAST(
          NEW.stock_before
          AS TEXT
        ) ||
        ' to ' ||
        CAST(
          NEW.stock_after
          AS TEXT
        ),

        'COMPLETED',

        json_object(
          'receiptId',
          NEW.id,

          'restockTaskId',
          NEW.restock_task_id,

          'quantityReceived',
          NEW.quantity_received,

          'stockBefore',
          NEW.stock_before,

          'stockAfter',
          NEW.stock_after,

          'locationId',
          NEW.location_id,

          'shopifyAdjustmentId',
          NEW.shopify_adjustment_id
        ),

        COALESCE(
          NEW.completed_at,
          datetime('now')
        )
      );

    END;
  `);

    /*
      AI STORE REPORT GENERATED
    */

    db.exec(`
    CREATE TRIGGER IF NOT EXISTS
    trg_ai_report_created

    AFTER INSERT ON ai_reports

    BEGIN

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

      VALUES (
        'ai-report:' ||
        CAST(
          NEW.id AS TEXT
        ),

        'AI',

        'AI_REPORT_GENERATED',

        'AI_REPORT',

        CAST(
          NEW.id AS TEXT
        ),

        'AI store report generated',

        'Analyzed ' ||
        CAST(
          NEW.order_count AS TEXT
        ) ||
        ' orders and ' ||
        CAST(
          NEW.product_count AS TEXT
        ) ||
        ' products.',

        'COMPLETED',

        json_object(
          'reportId',
          NEW.id,

          'model',
          NEW.model,

          'source',
          NEW.source,

          'productCount',
          NEW.product_count,

          'orderCount',
          NEW.order_count
        ),

        NEW.created_at
      );

    END;
  `);
}
