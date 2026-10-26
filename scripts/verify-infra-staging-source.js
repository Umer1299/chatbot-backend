import { assertInfraStaging } from '../src/config/infraStaging.js';
import { assertApprovedStagingSource } from '../src/config/approvedStagingSource.js';
import { stagingDatabaseSsl } from '../src/db/stagingTls.js';

assertInfraStaging();
assertApprovedStagingSource();
stagingDatabaseSsl(process.env.DATABASE_URL);
if (process.env.STAGING_DATABASE_URL !== process.env.DATABASE_URL)
  throw new Error('Staging database reference does not match API database');
if (!process.env.REDIS_URL || process.env.STAGING_REDIS_URL !== process.env.REDIS_URL)
  throw new Error('Staging Redis reference does not match API Redis');
console.log('Infra-only staging code and configuration preflight passed');
