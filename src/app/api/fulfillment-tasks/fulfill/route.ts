import {
  NextResponse,
} from "next/server";

import db from "@/lib/database";

import {
  ensureFulfillmentSchema,
} from "@/lib/fulfillment-schema";

import { hasAdminSession } from "@/lib/require-admin";
import { isSameOriginAdminRequest } from "@/lib/require-same-origin";

export const runtime = "nodejs";

ensureFulfillmentSchema(db);

/*
  ========================================
  SHOPIFY ACCESS TOKEN
  ========================================
*/

async function getAccessToken() {
  const shop =
    process.env.SHOPIFY_SHOP;

  const clientId =
    process.env.SHOPIFY_CLIENT_ID;

  const clientSecret =
    process.env.SHOPIFY_CLIENT_SECRET;

  if (
    !shop ||
    !clientId ||
    !clientSecret
  ) {
    throw new Error(
      "Missing Shopify environment variables"
    );
  }

  const response = await fetch(
    `https://${shop}.myshopify.com/admin/oauth/access_token`,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",
      },

      body: new URLSearchParams({
        grant_type:
          "client_credentials",

        client_id:
          clientId,

        client_secret:
          clientSecret,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(
      "Could not get Shopify access token"
    );
  }

  const data =
    await response.json();

  return data.access_token;
}

/*
  ========================================
  SHOPIFY GRAPHQL
  ========================================
*/

async function shopifyGraphQL(
  query: string,

  variables: Record<
    string,
    unknown
  >,

  token: string
) {
  const shop =
    process.env.SHOPIFY_SHOP;

  if (!shop) {
    throw new Error(
      "SHOPIFY_SHOP missing"
    );
  }

  const response = await fetch(
    `https://${shop}.myshopify.com/admin/api/2026-07/graphql.json`,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",

        "X-Shopify-Access-Token":
          token,
      },

      body:
        JSON.stringify({
          query,
          variables,
        }),
    }
  );

  const result =
    await response.json();

  if (!response.ok) {
    throw new Error(
      `Shopify request failed: ${response.status}`
    );
  }

  if (result.errors) {
    throw new Error(
      JSON.stringify(
        result.errors
      )
    );
  }

  return result.data;
}

/*
  ========================================
  READ CURRENT SHOPIFY STATE
  ========================================

  We always read Shopify again
  immediately before fulfillment.

  This protects us if the order
  changed after the local task
  was originally created.
*/

async function getCurrentState(
  orderGid: string,

  fulfillmentOrderId: string,

  token: string
) {
  const query = `
    query CurrentFulfillmentState(
      $orderId: ID!
    ) {
      order(
        id: $orderId
      ) {
        id
        name

        displayFinancialStatus
        displayFulfillmentStatus

        fulfillmentOrders(
          first: 50
        ) {
          nodes {
            id

            status
            requestStatus

            lineItems(
              first: 100
            ) {
              nodes {
                id

                totalQuantity
                remainingQuantity

                productTitle
                variantTitle
                sku
                requiresShipping
              }
            }
          }
        }
      }
    }
  `;

  const data =
    await shopifyGraphQL(
      query,

      {
        orderId:
          orderGid,
      },

      token
    );

  const order =
    data?.order;

  if (!order) {
    throw new Error(
      "Order no longer exists in Shopify."
    );
  }

  const fulfillmentOrder =
    order
      .fulfillmentOrders
      ?.nodes
      ?.find(
        (item: any) =>
          item.id ===
          fulfillmentOrderId
      );

  if (!fulfillmentOrder) {
    throw new Error(
      "Fulfillment order could not be found."
    );
  }

  const lineItems =
    fulfillmentOrder
      .lineItems
      ?.nodes || [];

  /*
    Only quantities that Shopify
    currently reports as remaining
    can be fulfilled.
  */

  const remainingItems =
    lineItems
      .filter(
        (item: any) =>
          Number(
            item.remainingQuantity
          ) > 0
      )
      .map(
        (item: any) => ({
          id:
            item.id,

          quantity:
            Number(
              item.remainingQuantity
            ),

          productTitle:
            item.productTitle,

          variantTitle:
            item.variantTitle,

          sku:
            item.sku,

          requiresShipping:
            item.requiresShipping,
        })
      );

  const remainingQuantity =
    remainingItems.reduce(
      (
        total: number,
        item: any
      ) =>
        total +
        Number(
          item.quantity || 0
        ),
      0
    );

  return {
    order,
    fulfillmentOrder,
    remainingItems,
    remainingQuantity,
  };
}

/*
  ========================================
  CREATE SHOPIFY FULFILLMENT
  ========================================
*/

async function createFulfillment(
  fulfillmentOrderId: string,

  remainingItems: Array<{
    id: string;
    quantity: number;
  }>,

  trackingCompany: string,

  trackingNumber: string,

  trackingUrl: string,

  notifyCustomer: boolean,

  token: string
) {
  const mutation = `
    mutation CreateFulfillment(
      $fulfillment: FulfillmentInput!
    ) {
      fulfillmentCreate(
        fulfillment: $fulfillment
      ) {
        fulfillment {
          id
          status

          trackingInfo(
            first: 10
          ) {
            company
            number
            url
          }
        }

        userErrors {
          field
          message
        }
      }
    }
  `;

  /*
    Base fulfillment input.
  */

  const fulfillmentInput:
    Record<string, any> = {
    lineItemsByFulfillmentOrder: [
      {
        fulfillmentOrderId,

        fulfillmentOrderLineItems:
          remainingItems.map(
            (item) => ({
              id:
                item.id,

              quantity:
                item.quantity,
            })
          ),
      },
    ],

    notifyCustomer,
  };

  /*
    Tracking information is optional.

    Shopify supports:
      company
      number
      url
  */

  if (
    trackingCompany ||
    trackingNumber ||
    trackingUrl
  ) {
    const trackingInfo:
      Record<string, string> = {};

    if (trackingCompany) {
      trackingInfo.company =
        trackingCompany;
    }

    if (trackingNumber) {
      trackingInfo.number =
        trackingNumber;
    }

    if (trackingUrl) {
      trackingInfo.url =
        trackingUrl;
    }

    fulfillmentInput.trackingInfo =
      trackingInfo;
  }

  const data =
    await shopifyGraphQL(
      mutation,

      {
        fulfillment:
          fulfillmentInput,
      },

      token
    );

  const payload =
    data
      ?.fulfillmentCreate;

  const userErrors =
    payload
      ?.userErrors || [];

  if (
    userErrors.length > 0
  ) {
    throw new Error(
      userErrors
        .map(
          (
            item: {
              message: string;
            }
          ) =>
            item.message
        )
        .join(", ")
    );
  }

  const fulfillment =
    payload?.fulfillment;

  if (!fulfillment?.id) {
    throw new Error(
      "Shopify did not return a fulfillment ID."
    );
  }

  return fulfillment;
}

/*
  ========================================
  POST
  ========================================

  Expected body:

  {
    "taskId":
      "fulfillment-task-123",

    "confirm":
      true,

    "trackingCompany":
      "UPS",

    "trackingNumber":
      "1Z123...",

    "trackingUrl":
      "",

    "notifyCustomer":
      false
  }
*/

export async function POST(
  request: Request
) {
  try {
    if (!(await hasAdminSession())) {
      return NextResponse.json(
        {
          success: false,
          error: "Unauthorized.",
        },
        {
          status: 401,
        }
      );
    }

    if (!isSameOriginAdminRequest(request)) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid request origin.",
        },
        {
          status: 403,
        }
      );
    }

    const body =
      await request.json();

    const taskId =
      String(
        body.taskId || ""
      ).trim();

    const confirmed =
      body.confirm === true;

    const trackingCompany =
      String(
        body.trackingCompany ||
        ""
      ).trim();

    const trackingNumber =
      String(
        body.trackingNumber ||
        ""
      ).trim();

    const trackingUrl =
      String(
        body.trackingUrl ||
        ""
      ).trim();

    const notifyCustomer =
      body.notifyCustomer ===
      true;

    /*
      ====================================
      VALIDATION
      ====================================
    */

    if (!taskId) {
      return NextResponse.json(
        {
          error:
            "taskId is required.",
        },
        {
          status: 400,
        }
      );
    }

    /*
      Fulfillment can never happen
      without explicit confirmation.
    */

    if (!confirmed) {
      return NextResponse.json(
        {
          error:
            "Explicit confirmation is required.",
        },
        {
          status: 400,
        }
      );
    }

    /*
      Validate tracking URL only
      when one is provided.
    */

    if (trackingUrl) {
      try {
        const url =
          new URL(
            trackingUrl
          );

        if (
          url.protocol !==
          "http:" &&
          url.protocol !==
          "https:"
        ) {
          throw new Error(
            "Invalid protocol"
          );
        }
      } catch {
        return NextResponse.json(
          {
            error:
              "Tracking URL must be a valid http or https URL.",
          },
          {
            status: 400,
          }
        );
      }
    }

    /*
      ====================================
      LOAD SQLITE TASK
      ====================================
    */

    const task =
      db.prepare(`
        SELECT *
        FROM fulfillment_tasks
        WHERE id = ?
        LIMIT 1
      `).get(
        taskId
      ) as any;

    if (!task) {
      return NextResponse.json(
        {
          error:
            "Fulfillment task not found.",
        },
        {
          status: 404,
        }
      );
    }

    /*
      ====================================
      IDEMPOTENCY GUARD
      ====================================

      Never fulfill a task twice.
    */

    if (
      task.status ===
      "COMPLETED"
    ) {
      return NextResponse.json({
        success:
          true,

        alreadyCompleted:
          true,

        taskId:
          task.id,

        orderName:
          task.order_name,

        shopifyFulfillmentId:
          task.shopify_fulfillment_id,
      });
    }

    /*
      Orders flagged for review
      cannot be automatically fulfilled.
    */

    if (
      task.status ===
      "REVIEW_REQUIRED"
    ) {
      return NextResponse.json(
        {
          error:
            "This fulfillment requires manual review and cannot be automatically fulfilled.",

          warning:
            task.warning,
        },
        {
          status: 409,
        }
      );
    }

    if (
      task.status !==
      "READY_TO_FULFILL"
    ) {
      return NextResponse.json(
        {
          error:
            `Task cannot be fulfilled while status is ${task.status}.`,
        },
        {
          status: 409,
        }
      );
    }

    /*
      ====================================
      GET SHOPIFY TOKEN
      ====================================
    */

    const token =
      await getAccessToken();

    /*
      ====================================
      FINAL LIVE SHOPIFY CHECK
      ====================================
    */

    const current =
      await getCurrentState(
        task.order_gid,

        task.fulfillment_order_id,

        token
      );

    /*
      ====================================
      FINANCIAL SAFETY CHECK
      ====================================

      Only fully paid orders proceed.
    */

    if (
      current.order
        .displayFinancialStatus !==
      "PAID"
    ) {
      const now =
        new Date().toISOString();

      const warning =
        `Order financial status changed to ${current.order.displayFinancialStatus}.`;

      db.prepare(`
        UPDATE fulfillment_tasks

        SET
          financial_status = ?,

          status =
            'REVIEW_REQUIRED',

          warning = ?,

          updated_at = ?

        WHERE id = ?
      `).run(
        current.order
          .displayFinancialStatus,

        warning,

        now,

        taskId
      );

      return NextResponse.json(
        {
          error:
            "Fulfillment blocked because the order is no longer fully paid.",

          financialStatus:
            current.order
              .displayFinancialStatus,

          status:
            "REVIEW_REQUIRED",
        },
        {
          status: 409,
        }
      );
    }

    /*
      ====================================
      FULFILLMENT ORDER SAFETY CHECK
      ====================================
    */

    if (
      current.fulfillmentOrder
        .status !==
      "OPEN"
    ) {
      const now =
        new Date().toISOString();

      const warning =
        `Fulfillment order status changed to ${current.fulfillmentOrder.status}.`;

      db.prepare(`
        UPDATE fulfillment_tasks

        SET
          fulfillment_order_status = ?,

          status =
            'REVIEW_REQUIRED',

          warning = ?,

          updated_at = ?

        WHERE id = ?
      `).run(
        current.fulfillmentOrder
          .status,

        warning,

        now,

        taskId
      );

      return NextResponse.json(
        {
          error:
            "Fulfillment blocked because the fulfillment order is no longer OPEN.",

          fulfillmentOrderStatus:
            current
              .fulfillmentOrder
              .status,
        },
        {
          status: 409,
        }
      );
    }

    /*
      ====================================
      NOTHING LEFT TO FULFILL
      ====================================
    */

    if (
      current.remainingQuantity <=
      0
    ) {
      const now =
        new Date().toISOString();

      let savedLineItems:
        any[] = [];

      try {
        savedLineItems =
          JSON.parse(
            task.line_items_json ||
            "[]"
          );
      } catch {
        savedLineItems = [];
      }

      const completedLineItems =
        savedLineItems.map(
          (item: any) => ({
            ...item,

            remainingQuantity:
              0,
          })
        );

      db.prepare(`
        UPDATE fulfillment_tasks

        SET
          remaining_quantity = 0,

          line_items_json = ?,

          fulfillment_order_status = ?,

          status =
            'COMPLETED',

          warning = NULL,

          updated_at = ?,

          completed_at = ?

        WHERE id = ?
      `).run(
        JSON.stringify(
          completedLineItems
        ),

        current.fulfillmentOrder
          .status,

        now,
        now,

        taskId
      );

      return NextResponse.json({
        success:
          true,

        alreadyFulfilled:
          true,

        message:
          "Nothing remains to fulfill.",
      });
    }

    /*
      ====================================
      ATOMIC PROCESSING CLAIM
      ====================================

      This prevents rapid double-clicks
      from fulfilling the same task twice.
    */

    const processingAt =
      new Date().toISOString();

    const claim =
      db.prepare(`
        UPDATE fulfillment_tasks

        SET
          status =
            'PROCESSING',

          updated_at = ?

        WHERE id = ?

        AND status =
          'READY_TO_FULFILL'
      `).run(
        processingAt,

        taskId
      );

    if (
      Number(
        claim.changes
      ) !== 1
    ) {
      return NextResponse.json(
        {
          error:
            "This fulfillment task is already being processed or its status changed.",
        },
        {
          status: 409,
        }
      );
    }

    /*
      ====================================
      CREATE REAL SHOPIFY FULFILLMENT
      ====================================
    */

    let fulfillment:
      any;

    try {
      fulfillment =
        await createFulfillment(
          task
            .fulfillment_order_id,

          current.remainingItems,

          trackingCompany,

          trackingNumber,

          trackingUrl,

          notifyCustomer,

          token
        );
    } catch (error) {
      /*
        Do not blindly retry a failed
        fulfillment request.

        If Shopify's response is uncertain,
        human review is safer than risking
        a duplicate fulfillment.
      */

      const failedAt =
        new Date().toISOString();

      const warning =
        error instanceof Error
          ? error.message
          : "Fulfillment request failed.";

      db.prepare(`
        UPDATE fulfillment_tasks

        SET
          status =
            'REVIEW_REQUIRED',

          warning = ?,

          updated_at = ?

        WHERE id = ?
      `).run(
        `Fulfillment attempt requires review: ${warning}`,

        failedAt,

        taskId
      );

      throw error;
    }

    /*
      ====================================
      READ SHOPIFY AGAIN AFTER SUCCESS
      ====================================
    */

    const after =
      await getCurrentState(
        task.order_gid,

        task.fulfillment_order_id,

        token
      );

    const completedAt =
      new Date().toISOString();

    /*
      ====================================
      FIX LOCAL LINE ITEM SNAPSHOT
      ====================================

      Our fulfillment action fulfills
      all remaining quantities.

      Therefore after successful
      completion, the local snapshot
      should also show zero remaining.
    */

    let savedLineItems:
      any[] = [];

    try {
      savedLineItems =
        JSON.parse(
          task.line_items_json ||
          "[]"
        );
    } catch {
      savedLineItems = [];
    }

    const completedLineItems =
      savedLineItems.map(
        (item: any) => ({
          ...item,

          remainingQuantity:
            0,
        })
      );

    /*
      ====================================
      SAVE COMPLETED TASK
      ====================================
    */

    db.prepare(`
      UPDATE fulfillment_tasks

      SET
        financial_status = ?,

        order_fulfillment_status = ?,

        fulfillment_order_status = ?,

        request_status = ?,

        remaining_quantity = ?,

        line_items_json = ?,

        status =
          'COMPLETED',

        warning = NULL,

        updated_at = ?,

        completed_at = ?,

        shopify_fulfillment_id = ?

      WHERE id = ?
    `).run(
      after.order
        .displayFinancialStatus,

      after.order
        .displayFulfillmentStatus,

      after.fulfillmentOrder
        .status,

      after.fulfillmentOrder
        .requestStatus,

      after.remainingQuantity,

      JSON.stringify(
        completedLineItems
      ),

      completedAt,

      completedAt,

      fulfillment.id,

      taskId
    );

    /*
      ====================================
      TRACKING RESULT
      ====================================

      Shopify returns trackingInfo
      as an ARRAY.
    */

    const trackingItems =
      Array.isArray(
        fulfillment.trackingInfo
      )
        ? fulfillment.trackingInfo
        : [];

    const savedTracking =
      trackingItems.length > 0
        ? trackingItems[0]
        : null;

    /*
      ====================================
      AGENT ACTIVITY LOG
      ====================================
    */

    db.prepare(`
      INSERT OR IGNORE
      INTO agent_events (
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
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `).run(
      `fulfillment-completed:${fulfillment.id}`,

      "SHOPIFY",

      "ORDER_FULFILLED",

      "ORDER",

      task.order_id,

      "Order fulfilled",

      `${task.order_name} fulfilled successfully. ${current.remainingQuantity} unit(s) processed.`,

      "COMPLETED",

      JSON.stringify({
        taskId:
          task.id,

        orderName:
          task.order_name,

        fulfillmentOrderId:
          task
            .fulfillment_order_id,

        shopifyFulfillmentId:
          fulfillment.id,

        quantityFulfilled:
          current.remainingQuantity,

        trackingCompany:
          savedTracking
            ?.company ||
          trackingCompany ||
          null,

        trackingNumber:
          savedTracking
            ?.number ||
          trackingNumber ||
          null,

        trackingUrl:
          savedTracking
            ?.url ||
          trackingUrl ||
          null,

        notifyCustomer,
      }),

      completedAt
    );

    /*
      ====================================
      SUCCESS RESPONSE
      ====================================
    */

    return NextResponse.json({
      success:
        true,

      source:
        "sqlite + shopify",

      taskId:
        task.id,

      orderName:
        task.order_name,

      quantityFulfilled:
        current.remainingQuantity,

      shopifyFulfillmentId:
        fulfillment.id,

      trackingInfo: {
        company:
          savedTracking
            ?.company ||
          trackingCompany ||
          null,

        number:
          savedTracking
            ?.number ||
          trackingNumber ||
          null,

        url:
          savedTracking
            ?.url ||
          trackingUrl ||
          null,
      },

      notifyCustomer,

      orderFulfillmentStatus:
        after.order
          .displayFulfillmentStatus,

      fulfillmentOrderStatus:
        after.fulfillmentOrder
          .status,

      remainingQuantity:
        after.remainingQuantity,

      taskStatus:
        "COMPLETED",
    });
  } catch (error) {
    console.error(
      "Fulfill order error:",
      error
    );

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not fulfill order.",
      },
      {
        status: 500,
      }
    );
  }
}