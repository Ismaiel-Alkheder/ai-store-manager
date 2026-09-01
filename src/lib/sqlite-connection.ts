import {
    DatabaseSync,
} from "node:sqlite";

import path from "node:path";

export const runtime = "nodejs";

const databasePath = path.join(
    process.cwd(),
    "data",
    "ai-store-manager.db"
);

const db = new DatabaseSync(
    databasePath,
    {
        timeout: 15000,
    }
);

export default db;