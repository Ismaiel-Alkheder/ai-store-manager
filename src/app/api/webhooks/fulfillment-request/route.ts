import {
    createHmac,
    timingSafeEqual,
} from "crypto";

import {
    NextResponse,
} from "next/server";

import db from "@/lib/database";

import {
    ensureFulfillmentSchema,
} from "@/lib/fulfillment-schema";

export const runtime =
    "nodejs";

ensureFulfillmentSchema(
    db
);

function verifyShopifyWebhook(
    rawBody: Buffer,
    hmacHeader: string,
    secret: string
) {
    const calculated =
        createHmac(
            "sha256",
            secret
        )
            .update(
                rawBody
            )
            .digest(
                "base64"
            );

    const received =
        Buffer.from(
            hmacHeader
        );

    const expected =
        Buffer.from(
            calculated
        );

    if (
        received.length !==
        expected.length
    ) {
        return false;
    }

    return timingSafeEqual(
        received,
        expected
    );
}

function normalizeEnum(
    value: unknown
) {
    if (
        value === null ||
        value === undefined
    ) {
        return null;
    }

    return String(
        value
    )
        .trim()
        .replace(
            /[\s-]+/g,
            "_"
        )
        .toUpperCase();
}

function normalizeTopic(
    value: string
) {
    return value
        .trim()
        .toLowerCase();
}

function toFulfillmentOrderGid(
    value: unknown
) {
    if (
        value === null ||
        value === undefined ||
        String(value).trim() === ""
    ) {
        return null;
    }

    const raw =
        String(value).trim();

    if (
        raw.startsWith(
            "gid://shopify/FulfillmentOrder/"
        )
    ) {
        return raw;
    }

    return `gid://shopify/FulfillmentOrder/${raw}`;
}

export async function POST(
    request: Request
) {
    try {
        const secret =
            process.env
                .SHOPIFY_CLIENT_SECRET;

        if (!secret) {
            return NextResponse.json(
                {
                    error:
                        "SHOPIFY_CLIENT_SECRET missing",
                },
                {
                    status:
                        500,
                }
            );
        }

        const rawBody =
            Buffer.from(
                await request.arrayBuffer()
            );

        const hmac =
            request.headers.get(
                "x-shopify-hmac-sha256"
            );

        const rawTopic =
            request.headers.get(
                "x-shopify-topic"
            );

        const webhookId =
            request.headers.get(
                "x-shopify-webhook-id"
            );

        if (
            !hmac ||
            !verifyShopifyWebhook(
                rawBody,
                hmac,
                secret
            )
        ) {
            return NextResponse.json(
                {
                    error:
                        "Invalid webhook signature",
                },
                {
                    status:
                        401,
                }
            );
        }

        if (!rawTopic) {
            return NextResponse.json(
                {
                    error:
                        "Webhook topic missing",
                },
                {
                    status:
                        400,
                }
            );
        }

        const topic =
            normalizeTopic(
                rawTopic
            );

        const supportedTopics =
            new Set([
                "fulfillment_orders/fulfillment_request_submitted",
                "fulfillment_orders/fulfillment_request_accepted",
                "fulfillment_orders/fulfillment_request_rejected",
            ]);

        if (
            !supportedTopics.has(
                topic
            )
        ) {
            return NextResponse.json({
                received:
                    true,

                ignored:
                    true,

                topic,
            });
        }

        const payload =
            JSON.parse(
                rawBody.toString(
                    "utf8"
                )
            );

        /*
          IMPORTANT:

          Shopify uses a DIFFERENT payload shape for
          fulfillment_request_submitted.

          submitted:
            original_fulfillment_order
            submitted_fulfillment_order
            fulfillment_order_merchant_request

          accepted / rejected:
            fulfillment_order
            message
        */
        let fulfillmentOrder:
            any = null;

        if (
            topic ===
            "fulfillment_orders/fulfillment_request_submitted"
        ) {
            fulfillmentOrder =
                payload
                    ?.submitted_fulfillment_order ||
                payload
                    ?.original_fulfillment_order ||
                payload
                    ?.fulfillment_order ||
                null;
        } else {
            fulfillmentOrder =
                payload
                    ?.fulfillment_order ||
                payload
                    ?.submitted_fulfillment_order ||
                payload
                    ?.original_fulfillment_order ||
                null;
        }

        const gid =
            toFulfillmentOrderGid(
                fulfillmentOrder
                    ?.id
            );

        /*
          Do not make Shopify retry forever for an
          unexpected payload. Log it, acknowledge it,
          and expose enough diagnostic information.
        */
        if (!gid) {
            console.warn(
                "Fulfillment request webhook payload did not contain a fulfillment order ID:",
                {
                    topic,
                    payload,
                }
            );

            return NextResponse.json({
                received:
                    true,

                matchedTask:
                    false,

                ignored:
                    true,

                reason:
                    "FULFILLMENT_ORDER_ID_MISSING",

                topic,
            });
        }

        const task =
            db.prepare(`
        SELECT *
        FROM fulfillment_tasks
        WHERE fulfillment_order_id = ?
        LIMIT 1
      `).get(
                gid
            ) as any;

        /*
          A webhook can arrive before our local task
          exists. Acknowledge it so Shopify does not
          retry forever.
        */
        if (!task) {
            return NextResponse.json({
                received:
                    true,

                matchedTask:
                    false,

                topic,

                fulfillmentOrderId:
                    gid,
            });
        }

        /*
          Never reopen a completed fulfillment.
        */
        if (
            task.status ===
            "COMPLETED"
        ) {
            return NextResponse.json({
                received:
                    true,

                matchedTask:
                    true,

                protected:
                    true,

                topic,

                taskId:
                    task.id,

                status:
                    "COMPLETED",
            });
        }

        const now =
            new Date()
                .toISOString();

        const liveFoStatus =
            normalizeEnum(
                fulfillmentOrder
                    ?.status
            );

        /*
          Topic semantics are authoritative here.
          This also protects us from payload-version
          differences where submitted payload examples
          can show transitional request_status values.
        */
        let liveRequestStatus =
            normalizeEnum(
                fulfillmentOrder
                    ?.request_status
            );

        if (
            topic ===
            "fulfillment_orders/fulfillment_request_submitted"
        ) {
            liveRequestStatus =
                "SUBMITTED";
        }

        if (
            topic ===
            "fulfillment_orders/fulfillment_request_accepted"
        ) {
            liveRequestStatus =
                "ACCEPTED";
        }

        if (
            topic ===
            "fulfillment_orders/fulfillment_request_rejected"
        ) {
            liveRequestStatus =
                "REJECTED";
        }

        const merchantRequestMessage =
            typeof payload
                ?.fulfillment_order_merchant_request
                ?.message ===
                "string"
                ? payload
                    .fulfillment_order_merchant_request
                    .message
                    .trim()
                : "";

        const topLevelMessage =
            typeof payload?.message ===
                "string"
                ? payload.message
                    .trim()
                : "";

        const message =
            topLevelMessage ||
            merchantRequestMessage;

        let localStatus =
            "PROCESSING";

        let warning:
            string | null = null;

        let eventType =
            "FULFILLMENT_REQUEST_UPDATED";

        let title =
            "Fulfillment request updated";

        if (
            topic ===
            "fulfillment_orders/fulfillment_request_submitted"
        ) {
            localStatus =
                "PROCESSING";

            eventType =
                "FULFILLMENT_REQUEST_SUBMITTED";

            title =
                "Fulfillment request submitted";

            warning =
                `Fulfillment request submitted to ${task.location_name || "the assigned fulfillment service"}. Waiting for acceptance or rejection.`;
        }

        if (
            topic ===
            "fulfillment_orders/fulfillment_request_accepted"
        ) {
            localStatus =
                "PROCESSING";

            eventType =
                "FULFILLMENT_REQUEST_ACCEPTED";

            title =
                "Fulfillment request accepted";

            warning =
                message
                    ? `Fulfillment request accepted by ${task.location_name || "the fulfillment service"}: ${message}`
                    : `Fulfillment request accepted by ${task.location_name || "the fulfillment service"}. Waiting for shipment completion.`;
        }

        if (
            topic ===
            "fulfillment_orders/fulfillment_request_rejected"
        ) {
            localStatus =
                "REVIEW_REQUIRED";

            eventType =
                "FULFILLMENT_REQUEST_REJECTED";

            title =
                "Fulfillment request rejected";

            warning =
                message
                    ? `Fulfillment request rejected by ${task.location_name || "the fulfillment service"}: ${message}`
                    : `Fulfillment request rejected by ${task.location_name || "the fulfillment service"}. Manual review is required.`;
        }

        db.prepare(`
      UPDATE fulfillment_tasks

      SET
        fulfillment_order_status =
          COALESCE(?, fulfillment_order_status),

        request_status =
          COALESCE(?, request_status),

        status = ?,

        warning = ?,

        updated_at = ?

      WHERE id = ?
    `).run(
            liveFoStatus,

            liveRequestStatus,

            localStatus,

            warning,

            now,

            task.id
        );

        const eventKey =
            webhookId
                ? `shopify-webhook:${webhookId}`
                : `${eventType}:${task.id}:${liveRequestStatus || "UNKNOWN"}:${now}`;

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
            eventKey,

            "SHOPIFY",

            eventType,

            "ORDER",

            String(
                task.order_id
            ),

            title,

            warning ||
            `${task.order_name} fulfillment request changed.`,

            liveRequestStatus ||
            localStatus,

            JSON.stringify({
                taskId:
                    task.id,

                orderName:
                    task.order_name,

                fulfillmentOrderId:
                    gid,

                locationName:
                    task.location_name,

                topic,

                shopifyFulfillmentOrderStatus:
                    liveFoStatus,

                shopifyRequestStatus:
                    liveRequestStatus,

                message:
                    message ||
                    null,
            }),

            now
        );

        return NextResponse.json({
            received:
                true,

            matchedTask:
                true,

            topic,

            taskId:
                task.id,

            orderName:
                task.order_name,

            fulfillmentOrderId:
                gid,

            status:
                localStatus,

            fulfillmentOrderStatus:
                liveFoStatus,

            requestStatus:
                liveRequestStatus,

            message:
                message ||
                null,
        });
    } catch (error) {
        console.error(
            "Fulfillment request webhook error:",
            error
        );

        return NextResponse.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Fulfillment request webhook failed",
            },
            {
                status:
                    500,
            }
        );
    }
}
