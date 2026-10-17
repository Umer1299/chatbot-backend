// Official CLI schema generation ONLY. No .env, database URL or production pool.
import pg from "pg";
import { createAccountAuth } from "../src/auth/accountAuth.js";
// Introspection sees an empty schema. No SQL is executed or network opened.
const schemaPool = new pg.Pool({ host: "127.0.0.1", port: 1 });
schemaPool.connect = async () => ({
  query: async () => ({ rows: [] }),
  release() {},
});
export const auth = createAccountAuth({
  database: schemaPool,
  settings: {
    baseURL: "http://localhost:3000",
    secret: "schema-generation-only-not-a-runtime-secret",
    trustedOrigins: ["http://localhost:3000"],
    production: false,
  },
  sendEmail: async () => {
    throw new Error("Schema generation cannot send email");
  },
});
