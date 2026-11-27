// Writes the OpenAPI document to services/core-api/openapi.json without touching the database.
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig({ ...process.env, JWT_SECRET: process.env.JWT_SECRET ?? 'openapi-generation-only-secret' });
const app = await buildApp({ config, logger: false });
await app.ready();
const spec = app.swagger();
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'openapi.json');
writeFileSync(out, JSON.stringify(spec, null, 2) + '\n');
console.log(`wrote ${out} (${Object.keys((spec as { paths: object }).paths).length} paths)`);
await app.close();
