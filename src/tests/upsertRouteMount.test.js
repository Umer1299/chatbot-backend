import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');

test('upsert routes are mounted at both API and legacy paths', () => {
  assert.match(appSource, /app\.use\('\/api\/upsert', widgetLimiter\)/);
  assert.match(appSource, /app\.use\('\/upsert', widgetLimiter\)/);
  assert.match(appSource, /app\.use\('\/api\/upsert', upsertRoutes\)/);
  assert.match(appSource, /app\.use\('\/upsert', upsertRoutes\)/);
});
