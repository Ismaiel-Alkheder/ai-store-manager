import db from "./database";

import type {
    MarketCitation,
    MarketScan,
    MarketScanResult,
} from "./market-scan-types";

type MarketScanRow = {
    id: number;
    result_json: string;
    citations_json: string;
    model: string;
    source_count: number;
    created_at: string;
};

function parseJson<T>(
    value: string,
    fallback: T
): T {
    try {
        return JSON.parse(value) as T;
    } catch {
        return fallback;
    }
}

function mapMarketScan(
    row: MarketScanRow
): MarketScan {
    return {
        id: Number(row.id),
        result: parseJson(
            row.result_json,
            {
                summary:
                    "Stored market scan could not be read.",
                marketSignals: [],
                candidates: [],
                avoid: [],
                nextStep: "Run a new market scan.",
                disclaimer:
                    "Research candidate only.",
            }
        ),
        citations: parseJson<MarketCitation[]>(
            row.citations_json,
            []
        ),
        model: row.model,
        sourceCount:
            Number(row.source_count),
        createdAt: row.created_at,
    };
}

export function createMarketScan({
    result,
    citations,
    model,
}: {
    result: MarketScanResult;
    citations: MarketCitation[];
    model: string;
}): MarketScan {
    const createdAt =
        new Date().toISOString();

    const insertResult = db
        .prepare(`
      INSERT INTO market_scans (
        result_json,
        citations_json,
        model,
        source_count,
        created_at
      )

      VALUES (?, ?, ?, ?, ?)
    `)
        .run(
            JSON.stringify(result),
            JSON.stringify(citations),
            model,
            citations.length,
            createdAt
        );

    return {
        id: Number(
            insertResult.lastInsertRowid
        ),
        result,
        citations,
        model,
        sourceCount: citations.length,
        createdAt,
    };
}

export function listMarketScans(
    requestedLimit = 5
): MarketScan[] {
    const limit = Math.min(
        Math.max(
            Math.trunc(requestedLimit),
            1
        ),
        20
    );

    const rows = db
        .prepare(`
      SELECT
        id,
        result_json,
        citations_json,
        model,
        source_count,
        created_at

      FROM market_scans

      ORDER BY
        datetime(created_at) DESC,
        id DESC

      LIMIT ?
    `)
        .all(limit) as MarketScanRow[];

    return rows.map(mapMarketScan);
}
