import {
    DatabaseSync,
} from "node:sqlite";
import {
    mkdirSync,
} from "node:fs";
import path from "node:path";

export const runtime = "nodejs";

const dataDirectory = path.join(
    process.cwd(),
    "data"
);

mkdirSync(
    dataDirectory,
    {
        recursive: true,
    }
);

/*
  Keep each Shopify store in a separate SQLite database.

  Examples:
  - ai-store-manager-ai-store-test-cd4xriyx.db
  - ai-store-manager-hmmdhq-t3.db

  This prevents reports, approvals, tasks, webhook events,
  and inventory alerts from one store appearing in another.
*/

const rawShopKey =
    process.env.SHOPIFY_SHOP ||
    "local";

const shopKey =
    rawShopKey
        .trim()
        .toLowerCase()
        .replace(
            /\.myshopify\.com$/,
            ""
        )
        .replace(
            /[^a-z0-9_-]+/g,
            "-"
        )
        .replace(
            /^-+|-+$/g,
            ""
        ) || "local";

const databasePath = path.join(
    dataDirectory,
    `ai-store-manager-${shopKey}.db`
);

const db = new DatabaseSync(
    databasePath,
    {
        timeout: 15000,
    }
);

export default db;
