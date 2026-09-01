import { NextResponse } from "next/server";
import db from "@/lib/database";
import { ensureFulfillmentSchema } from "@/lib/fulfillment-schema";
import { hasAdminSession } from "@/lib/require-admin";
import { isSameOriginAdminRequest } from "@/lib/require-same-origin";

export const runtime = "nodejs";

ensureFulfillmentSchema(db);

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

    const response =
        await fetch(
            `https://${shop}.myshopify.com/admin/oauth/access_token`,
            {
                method:
                    "POST",

                headers: {
                    "Content-Type":
                        "application/x-www-form-urlencoded",
                },

                body:
                    new URLSearchParams({
                        grant_type:
                            "client_credentials",

                        client_id:
                            clientId,

                        client_secret:
                            clientSecret,
                    }),
            }
        );

    const data =
        await response.json();

    if (!response.ok) {
        throw new Error(
            `Could not get Shopify access token: ${response.status} ${JSON.stringify(
                data
            )}`
        );
    }

    return data.access_token;
}

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

    const response =
        await fetch(
            `https://${shop}.myshopify.com/admin/api/2026-07/graphql.json`,
            {
                method:
                    "POST",

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

                cache:
                    "no-store",
            }
        );

    const result =
        await response.json();

    if (!response.ok) {
        throw new Error(
            `Shopify request failed: ${response.status} ${JSON.stringify(
                result
            )}`
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

function fail(
    message: string,
    status = 400,
    extra: Record<
        string,
        unknown
    > = {}
) {
    return NextResponse.json(
        {
            success:
                false,

            error:
                message,

            ...extra,
        },

        {
            status,
        }
    );
}

/*
  POST /api/fulfillment-tasks/request

  Body:
  {
    "taskId": "...",
    "confirm": true,
    "notifyCustomer": false,
    "message": "optional"
  }

  This route is ONLY for a Shopify
  fulfillment order whose live supportedActions
  includes REQUEST_FULFILLMENT.

  It does not use fulfillmentCreate.
*/
export async function POST(
    request: Request
) {
    let claimedTaskId:
        string | null = null;

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

        const body =
            await request.json();

        const taskId =
            String(
                body?.taskId ||
                ""
            ).trim();

        const confirm =
            body?.confirm ===
            true;

        const notifyCustomer =
            body?.notifyCustomer ===
            true;

        const message =
            typeof body?.message ===
                "string"
                ? body.message
                    .trim()
                    .slice(
                        0,
                        1000
                    )
                : "";

        if (!taskId) {
            return fail(
                "taskId is required."
            );
        }

        if (!confirm) {
            return fail(
                "Explicit confirmation is required. Send confirm: true."
            );
        }

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
            return fail(
                "Fulfillment task not found.",
                404
            );
        }

        /*
          Approval gate:
          a third-party request must never be sent
          just because a task happens to be READY.
        */
        const approval =
            db.prepare(`
        SELECT
          id,
          status
        FROM approvals
        WHERE order_id = ?
          AND action = ?
        LIMIT 1
      `).get(
                task.order_id,
                "REVIEW_FULFILLMENT"
            ) as any;

        if (
            !approval ||
            approval.status !==
            "APPROVED"
        ) {
            return fail(
                "Order fulfillment has not been approved.",
                409,
                {
                    approvalStatus:
                        approval
                            ?.status ||
                        "MISSING",
                }
            );
        }

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

                status:
                    task.status,

                requestStatus:
                    task.request_status,
            });
        }

        /*
          If the request was already submitted,
          treat a retry as idempotent and do not
          send another request.
        */
        if (
            task.request_status ===
            "SUBMITTED"
        ) {
            return NextResponse.json({
                success:
                    true,

                alreadySubmitted:
                    true,

                taskId:
                    task.id,

                orderName:
                    task.order_name,

                status:
                    task.status,

                requestStatus:
                    task.request_status,
            });
        }

        if (
            task.status !==
            "READY_TO_FULFILL"
        ) {
            return fail(
                `Task is ${task.status}, not READY_TO_FULFILL.`,
                409
            );
        }

        const token =
            await getAccessToken();

        /*
          Re-read the Fulfillment Order LIVE
          immediately before mutation.
        */
        const liveData =
            await shopifyGraphQL(
                `
        query RequestFulfillmentSafetyCheck(
          $id: ID!
        ) {
          fulfillmentOrder(
            id: $id
          ) {
            id
            status
            requestStatus

            supportedActions {
              action
              externalUrl
            }

            order {
              id
              name
              displayFinancialStatus
              displayFulfillmentStatus
            }

            lineItems(
              first: 100
            ) {
              nodes {
                id
                remainingQuantity
              }
            }
          }
        }
        `,

                {
                    id:
                        task.fulfillment_order_id,
                },

                token
            );

        const fulfillmentOrder =
            liveData
                ?.fulfillmentOrder;

        if (!fulfillmentOrder) {
            return fail(
                "Shopify Fulfillment Order was not found.",
                404
            );
        }

        const order =
            fulfillmentOrder
                .order;

        if (!order) {
            return fail(
                "Shopify order was not found for this Fulfillment Order.",
                404
            );
        }

        if (
            order
                .displayFinancialStatus !==
            "PAID"
        ) {
            return fail(
                `Order financial status is ${order.displayFinancialStatus}. Request blocked.`,
                409
            );
        }

        if (
            fulfillmentOrder
                .status !==
            "OPEN"
        ) {
            return fail(
                `Fulfillment Order status is ${fulfillmentOrder.status}. Request blocked.`,
                409
            );
        }

        /*
          Only UNSUBMITTED requests may be sent.
          If Shopify already says SUBMITTED,
          synchronize locally and return safely.
        */
        if (
            fulfillmentOrder
                .requestStatus ===
            "SUBMITTED"
        ) {
            const now =
                new Date()
                    .toISOString();

            db.prepare(`
        UPDATE fulfillment_tasks
        SET
          request_status = ?,
          status = ?,
          warning = ?,
          updated_at = ?
        WHERE id = ?
      `).run(
                "SUBMITTED",
                "PROCESSING",
                "Fulfillment request is already submitted to the assigned fulfillment service.",
                now,
                task.id
            );

            return NextResponse.json({
                success:
                    true,

                alreadySubmitted:
                    true,

                source:
                    "SHOPIFY_LIVE_STATE",

                taskId:
                    task.id,

                orderName:
                    order.name,

                status:
                    "PROCESSING",

                requestStatus:
                    "SUBMITTED",
            });
        }

        if (
            fulfillmentOrder
                .requestStatus !==
            "UNSUBMITTED"
        ) {
            return fail(
                `Fulfillment request status is ${fulfillmentOrder.requestStatus}. Request blocked.`,
                409
            );
        }

        const actions =
            (
                fulfillmentOrder
                    .supportedActions ||
                []
            ).map(
                (
                    item: any
                ) =>
                    item.action
            );

        if (
            !actions.includes(
                "REQUEST_FULFILLMENT"
            )
        ) {
            return fail(
                "This Fulfillment Order does not support REQUEST_FULFILLMENT.",
                409,
                {
                    supportedActions:
                        actions,
                }
            );
        }

        const remainingQuantity =
            (
                fulfillmentOrder
                    .lineItems
                    ?.nodes ||
                []
            ).reduce(
                (
                    total:
                        number,
                    item:
                        any
                ) =>
                    total +
                    Number(
                        item
                            .remainingQuantity ||
                        0
                    ),
                0
            );

        if (
            remainingQuantity <=
            0
        ) {
            return fail(
                "No remaining quantity needs fulfillment.",
                409
            );
        }

        /*
          Atomic local claim:
          only one request may move this task
          from READY_TO_FULFILL to PROCESSING.
        */
        const claim =
            db.prepare(`
        UPDATE fulfillment_tasks
        SET
          status = ?,
          warning = ?,
          updated_at = ?
        WHERE id = ?
          AND status = ?
      `).run(
                "PROCESSING",
                "Submitting fulfillment request to assigned fulfillment service.",
                new Date()
                    .toISOString(),
                task.id,
                "READY_TO_FULFILL"
            );

        if (
            Number(
                claim.changes
            ) !==
            1
        ) {
            return fail(
                "Task changed before it could be claimed. Refresh and try again.",
                409
            );
        }

        claimedTaskId =
            task.id;

        /*
          We intentionally omit
          fulfillmentOrderLineItems so Shopify
          submits ALL remaining items in this
          Fulfillment Order.
        */
        const mutationData =
            await shopifyGraphQL(
                `
        mutation SubmitFulfillmentRequest(
          $id: ID!,
          $message: String,
          $notifyCustomer: Boolean
        ) {
          fulfillmentOrderSubmitFulfillmentRequest(
            id: $id,
            message: $message,
            notifyCustomer: $notifyCustomer
          ) {
            originalFulfillmentOrder {
              id
              status
              requestStatus
            }

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
                    id:
                        fulfillmentOrder.id,

                    message:
                        message ||
                        null,

                    notifyCustomer,
                },

                token
            );

        const mutationResult =
            mutationData
                ?.fulfillmentOrderSubmitFulfillmentRequest;

        const userErrors =
            mutationResult
                ?.userErrors ||
            [];

        if (
            userErrors.length >
            0
        ) {
            const errorText =
                userErrors
                    .map(
                        (
                            item: any
                        ) =>
                            item.message
                    )
                    .join(
                        "; "
                    );

            db.prepare(`
        UPDATE fulfillment_tasks
        SET
          status = ?,
          warning = ?,
          updated_at = ?
        WHERE id = ?
      `).run(
                "REVIEW_REQUIRED",
                `Fulfillment request attempt requires review: ${errorText}`,
                new Date()
                    .toISOString(),
                task.id
            );

            claimedTaskId =
                null;

            return fail(
                "Shopify rejected the fulfillment request.",
                409,
                {
                    userErrors,
                }
            );
        }

        const submitted =
            mutationResult
                ?.submittedFulfillmentOrder;

        if (
            !submitted ||
            submitted
                .requestStatus !==
            "SUBMITTED"
        ) {
            throw new Error(
                "Shopify did not confirm a SUBMITTED fulfillment request."
            );
        }

        const now =
            new Date()
                .toISOString();

        db.prepare(`
      UPDATE fulfillment_tasks
      SET
        fulfillment_order_status = ?,
        request_status = ?,
        status = ?,
        warning = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
            submitted.status ||
            fulfillmentOrder
                .status,

            submitted
                .requestStatus,

            "PROCESSING",

            `Fulfillment request submitted to ${task.location_name || "assigned fulfillment service"}. Waiting for the service to accept or reject it.`,

            now,

            task.id
        );

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
            `fulfillment-request-submitted:${task.id}`,

            "SHOPIFY",

            "FULFILLMENT_REQUEST_SUBMITTED",

            "ORDER",

            String(
                task.order_id
            ),

            "Fulfillment request submitted",

            `${task.order_name} was submitted to ${task.location_name || "the assigned fulfillment service"}.`,

            "SUBMITTED",

            JSON.stringify({
                taskId:
                    task.id,

                orderName:
                    task.order_name,

                fulfillmentOrderId:
                    fulfillmentOrder.id,

                submittedFulfillmentOrderId:
                    submitted.id,

                locationName:
                    task.location_name,

                remainingQuantity,

                notifyCustomer,

                message:
                    message ||
                    null,
            }),

            now
        );

        claimedTaskId =
            null;

        return NextResponse.json({
            success:
                true,

            action:
                "REQUEST_FULFILLMENT",

            taskId:
                task.id,

            orderName:
                task.order_name,

            fulfillmentOrderId:
                fulfillmentOrder.id,

            assignedLocation:
                task.location_name,

            remainingQuantity,

            status:
                "PROCESSING",

            requestStatus:
                submitted
                    .requestStatus,

            submittedFulfillmentOrder:
                submitted,

            unsubmittedFulfillmentOrder:
                mutationResult
                    ?.unsubmittedFulfillmentOrder ||
                null,
        });
    } catch (error) {
        /*
          If we had already claimed the task and
          then lost certainty about Shopify's
          mutation result, never silently retry.
        */
        if (
            claimedTaskId
        ) {
            try {
                db.prepare(`
          UPDATE fulfillment_tasks
          SET
            status = ?,
            warning = ?,
            updated_at = ?
          WHERE id = ?
        `).run(
                    "REVIEW_REQUIRED",

                    `Fulfillment request attempt requires review: ${error instanceof Error
                        ? error.message
                        : "Unknown error"
                    }`,

                    new Date()
                        .toISOString(),

                    claimedTaskId
                );
            } catch {
                // Do not hide the original error.
            }
        }

        return NextResponse.json(
            {
                success:
                    false,

                error:
                    error instanceof Error
                        ? error.message
                        : "Fulfillment request failed.",
            },

            {
                status: 500,
            }
        );
    }
}
