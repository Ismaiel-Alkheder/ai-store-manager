import db from "./sqlite-connection";

import {
  installAgentEventTriggers,
} from "./agent-event-triggers";

import {
  initializeSqliteSchema,
} from "./sqlite-schema";

initializeSqliteSchema(db);

export default db;