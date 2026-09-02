import db from "./database";

export type AiReport = {
    id: number;
    analysis: string;
    model: string;
    source: string;
    productCount: number;
    orderCount: number;
    createdAt: string;
};

type AiReportRow = {
    id: number;
    analysis: string;
    model: string;
    source: string;
    product_count: number;
    order_count: number;
    created_at: string;
};

function mapAiReport(
    row: AiReportRow
): AiReport {
    return {
        id: Number(row.id),
        analysis: row.analysis,
        model: row.model,
        source: row.source,
        productCount:
            Number(row.product_count),
        orderCount:
            Number(row.order_count),
        createdAt: row.created_at,
    };
}

export function createAiReport({
    analysis,
    model,
    source = "MANUAL",
    productCount,
    orderCount,
}: {
    analysis: string;
    model: string;
    source?: string;
    productCount: number;
    orderCount: number;
}): AiReport {
    const createdAt =
        new Date().toISOString();

    const result = db
        .prepare(`
      INSERT INTO ai_reports (
        analysis,
        model,
        source,
        product_count,
        order_count,
        created_at
      )

      VALUES (?, ?, ?, ?, ?, ?)
    `)
        .run(
            analysis,
            model,
            source,
            productCount,
            orderCount,
            createdAt
        );

    return {
        id: Number(
            result.lastInsertRowid
        ),
        analysis,
        model,
        source,
        productCount,
        orderCount,
        createdAt,
    };
}

export function listAiReports(
    requestedLimit = 10
): AiReport[] {
    const limit = Math.min(
        Math.max(
            Math.trunc(requestedLimit),
            1
        ),
        50
    );

    const rows = db
        .prepare(`
      SELECT
        id,
        analysis,
        model,
        source,
        product_count,
        order_count,
        created_at

      FROM ai_reports

      ORDER BY
        datetime(created_at) DESC,
        id DESC

      LIMIT ?
    `)
        .all(limit) as AiReportRow[];

    return rows.map(
        mapAiReport
    );
}
