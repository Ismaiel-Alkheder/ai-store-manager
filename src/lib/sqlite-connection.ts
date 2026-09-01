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

const databasePath = path.join(
    dataDirectory,
    "ai-store-manager.db"
);

const db = new DatabaseSync(
    databasePath,
    {
        timeout: 15000,
    }
);

export default db;