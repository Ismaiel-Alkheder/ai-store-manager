import { NextResponse } from "next/server";

import db from "@/lib/database";
import { ensureFulfillmentSchema } from "@/lib/fulfillment-schema";
import { hasAdminSession } from "@/lib/require-admin";
import { isSameOriginAdminRequest } from "@/lib/require-same-origin";

export const runtime = "nodejs";

ensureFulfillmentSchema(db);

const API_VERSION = "2026-07";

async function getAccessToken() {
    const shop = process.env.SHOPIFY_SHOP;
    const clientId = process.env.SHOPIFY_CLIENT_ID;
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

    if (!shop || !clientId || !clientSecret) {
        throw new Error("Missing Shopify environment variables.");
    }

    const response = await fetch(
        `https://${shop}.myshopify.com/admin/oauth/access_token`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
                grant_type: "client_credentials",
                client_id: clientId,
                client_secret: clientSecret,
            }),
            cache: "no-store",
        }
    );

    const data = await response.json();

    if (!response.ok) {
        throw new Error(
            `Could not get Shopify access token: ${response.status} ${JSON.stringify(data)}`
        );
    }

    return data.access_token as string;
}

async function shopifyGraphQL(
    query: string,
    variables: Record<string, unknown>,
    token: string
) {
    const shop = process.env.SHOPIFY_SHOP;

    if (!shop) {
        throw new Error("SHOPIFY_SHOP missing.");
    }

    const response = await fetch(
        `https://${shop}.myshopify.com/admin/api/${API_VERSION}/graphql.json`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Shopify-Access-Token": token,
            },
            body: JSON.stringify({ query, variables }),
            cache: "no-store",
        }
    );

    const result = await response.json();

    if (!response.ok) {
        throw new Error(
            `Shopify request failed: ${response.status} ${JSON.stringify(result)}`
        );
    }

    if (result.errors) {
        throw new Error(JSON.stringify(result.errors));
    }

    return result.data;
}

function fail(
    message: string,
    status = 400,
    extra: Record<string, unknown> = {}
) {
    return NextResponse.json(
        {
            success: false,
            error: message,
            ...extra,
        },
        { status }
    );
}

/*
  POST /api/fulfillment-tasks/retry

  Body:
  {
    "taskId": "fulfillment-task-8725885419829",
    "confirm": true,
    "notifyCustomer": false,
    "message": "Retry fulfillment request"
  }

  Safe retry rules:
  - local task must be REVIEW_REQUIRED + REJECTED
  - order must still be PAID
  - Fulfillment Order must be OPEN
  - Shopify requestStatus must still be REJECTED
  - Shopify supportedActions must include REQUEST_FULFILLMENT
  - remaining quantity must be greater than zero
  - atomic local claim prevents double-click duplicate attempts
*/
export async function POST(request: Request) {
    try {
        if (!(await hasAdminSession())) {
            return NextResponse.json(
                {
                    success: false,
                    error: "Unauthorized.",
                },
                { status: 401 }
            );
        }

        if (!isSameOriginAdminRequest(request)) {
            return NextResponse.json(
                {
                    success: false,
                    error: "Invalid request origin.",
                },
                { status: 403 }
            );
        }

        const body = await request.json();

        const taskId =
            typeof body?.taskId === "string"
                ? body.taskId.trim()
                : "";

        const confirm = body?.confirm === true;
        const notifyCustomer = body?.notifyCustomer === true;

        const message =
            typeof body?.message === "string" && body.message.trim()
                ? body.message.trim().slice(0, 1000)
                : "Retry fulfillment request";

        if (!taskId) {
            return fail("taskId is required.");
        }

        if (!confirm) {
            return fail(
                "Explicit confirmation is required. Send confirm: true."
            );
        }

        const task = db
            .prepare(`
        SELECT
          id,
          order_id,
          order_gid,
          order_name,
          fulfillment_order_id,
          location_id,
          location_name,
          financial_status,
          order_fulfillment_status,
          fulfillment_order_status,
          request_status,
          remaining_quantity,
          status,
          warning
        FROM fulfillment_tasks
        WHERE id = ?
        LIMIT 1
      `)
            .get(taskId) as any;

        if (!task) {
            return fail("Fulfillment task not found.", 404);
        }

        if (
            String(task.status || "").toUpperCase() !== "REVIEW_REQUIRED" ||
            String(task.request_status || "").toUpperCase() !== "REJECTED"
        ) {
            return fail(
                `Retry is allowed only for REVIEW_REQUIRED + REJECTED tasks. Current local state: ${task.status} / ${task.request_status}.`,
                409
            );
        }

        if (!task.fulfillment_order_id) {
            return fail("Task has no fulfillment_order_id.", 409);
        }

        const token = await getAccessToken();

        const liveData = await shopifyGraphQL(
            `
      query RetryFulfillmentSafetyCheck($id: ID!) {
        fulfillmentOrder(id: $id) {
          id
          status
          requestStatus

          supportedActions {
            action
            externalUrl
          }

          assignedLocation {
            name
            location {
              id
            }
          }

          order {
            id
            name
            displayFinancialStatus
            displayFulfillmentStatus
          }

          lineItems(first: 100) {
            nodes {
              id
              remainingQuantity
            }
          }
        }
      }
      `,
            {
                id: task.fulfillment_order_id,
            },
            token
        );

        const live = liveData?.fulfillmentOrder;

        if (!live) {
            return fail("Shopify Fulfillment Order was not found.", 404);
        }

        if (live.order?.displayFinancialStatus !== "PAID") {
            return fail(
                `Order financial status is ${live.order?.displayFinancialStatus}. Expected PAID.`,
                409
            );
        }

        if (live.status !== "OPEN") {
            return fail(
                `Fulfillment Order status is ${live.status}. Expected OPEN.`,
                409
            );
        }

        if (live.requestStatus !== "REJECTED") {
            return fail(
                `Shopify requestStatus is ${live.requestStatus}. Expected REJECTED before retry.`,
                409
            );
        }

        const supportedActions = Array.isArray(live.supportedActions)
            ? live.supportedActions.map((item: any) => item?.action).filter(Boolean)
            : [];

        if (!supportedActions.includes("REQUEST_FULFILLMENT")) {
            return fail(
                "Shopify does not currently allow REQUEST_FULFILLMENT for this Fulfillment Order.",
                409,
                { supportedActions }
            );
        }

        const remainingQuantity = (live.lineItems?.nodes || []).reduce(
            (total: number, item: any) =>
                total + Number(item?.remainingQuantity || 0),
            0
        );

        if (remainingQuantity <= 0) {
            return fail(
                "No remaining quantity needs fulfillment.",
                409
            );
        }

        /*
          Claim the local task before calling Shopify.
          This protects against accidental double-clicks.
        */
        const now = new Date().toISOString();

        const claim = db
            .prepare(`
        UPDATE fulfillment_tasks
        SET
          status = 'PROCESSING',
          warning = ?,
          updated_at = ?
        WHERE id = ?
          AND status = 'REVIEW_REQUIRED'
          AND request_status = 'REJECTED'
      `)
            .run(
                "Retrying fulfillment request with Shopify.",
                now,
                taskId
            );

        if (Number(claim.changes) !== 1) {
            return fail(
                "Task state changed before retry could start. Refresh the page and review the latest state.",
                409
            );
        }

        let mutationAttempted = false;

        try {
            mutationAttempted = true;

            const mutationData = await shopifyGraphQL(
                `
        mutation RetryFulfillmentRequest(
          $id: ID!,
          $message: String,
          $notifyCustomer: Boolean
        ) {
          fulfillmentOrderSubmitFulfillmentRequest(
            id: $id,
            message: $message,
            notifyCustomer: $notifyCustomer
          ) {
            submittedFulfillmentOrder {
              id
              status
              requestStatus
            }

            unsubmittedFulfillmentOrder {
              id
              status
              requestStatus
            }

            userErrors {
              field
              message
            }
          }
        }
        `,
                {
                    id: task.fulfillment_order_id,
                    message,
                    notifyCustomer,
                },
                token
            );

            const result =
                mutationData?.fulfillmentOrderSubmitFulfillmentRequest;

            const userErrors = result?.userErrors || [];

            if (userErrors.length > 0) {
                db.prepare(`
          UPDATE fulfillment_tasks
          SET
            status = 'REVIEW_REQUIRED',
            warning = ?,
            updated_at = ?
          WHERE id = ?
        `).run(
                    `Retry rejected by Shopify: ${userErrors
                        .map((item: any) => item?.message)
                        .filter(Boolean)
                        .join(" | ")}`,
                    new Date().toISOString(),
                    taskId
                );

                return fail(
                    "Shopify rejected the fulfillment retry.",
                    409,
                    { userErrors }
                );
            }

            const submitted = result?.submittedFulfillmentOrder;

            if (!submitted || submitted.requestStatus !== "SUBMITTED") {
                throw new Error(
                    "Shopify did not confirm requestStatus SUBMITTED after retry."
                );
            }

            db.prepare(`
        UPDATE fulfillment_tasks
        SET
          fulfillment_order_status = ?,
          request_status = 'SUBMITTED',
          remaining_quantity = ?,
          status = 'PROCESSING',
          warning = NULL,
          updated_at = ?
        WHERE id = ?
      `).run(
                submitted.status || live.status || "OPEN",
                remainingQuantity,
                new Date().toISOString(),
                taskId
            );

            return NextResponse.json({
                success: true,
                action: "RETRY_FULFILLMENT_REQUEST",
                taskId,
                orderName: live.order?.name || task.order_name || null,
                assignedLocation:
                    live.assignedLocation?.name ||
                    task.location_name ||
                    null,
                remainingQuantity,
                status: "PROCESSING",
                requestStatus: "SUBMITTED",
                submittedFulfillmentOrder: submitted,
                unsubmittedFulfillmentOrder:
                    result?.unsubmittedFulfillmentOrder || null,
            });
        } catch (error) {
            /*
              Once the mutation may have been sent, do not pretend we know
              the final remote state. Put the task back into REVIEW_REQUIRED
              with a warning so the operator can reconcile safely.
            */
            db.prepare(`
        UPDATE fulfillment_tasks
        SET
          status = 'REVIEW_REQUIRED',
          warning = ?,
          updated_at = ?
        WHERE id = ?
      `).run(
                mutationAttempted
                    ? `Fulfillment retry attempt requires review: ${error instanceof Error ? error.message : String(error)
                    }`
                    : `Fulfillment retry could not start: ${error instanceof Error ? error.message : String(error)
                    }`,
                new Date().toISOString(),
                taskId
            );

            throw error;
        }
    } catch (error) {
        console.error("Fulfillment retry error:", error);

        return NextResponse.json(
            {
                success: false,
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not retry fulfillment request.",
            },
            { status: 500 }
        );
    }
}
