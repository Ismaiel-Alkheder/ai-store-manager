import db from "./sqlite-connection";

import {
  initializeSqliteSchema,
} from "./sqlite-schema";

initializeSqliteSchema(db);

export default db;