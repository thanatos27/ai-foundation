/**
 * Prints the REST API's OpenAPI document to stdout, generated from the routes exactly as
 * GET /openapi.json serves it, for review or diffs. Nothing is contacted and no API key is needed:
 *
 *   npm run --silent openapi [-- --config config.local.yaml] > openapi.json
 *
 * The output is not committed: the routes and schemas are the source of the document.
 */
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createHttpApp } from '../src/http/app.js';
import { COMMON_ARG_OPTIONS, exitOnStartupError, loadContext } from '../src/startup.js';

async function main(): Promise<void> {
  const { values: args } = parseArgs({ options: COMMON_ARG_OPTIONS });
  const context = await loadContext(args);
  // A key for this process only, to pass the app's own authentication.
  const apiKey = randomBytes(32).toString('base64url');
  const app = createHttpApp({ ...context, apiKey });
  const response = await app.request('/openapi.json', { headers: { Authorization: `Bearer ${apiKey}` } });
  process.stdout.write(`${JSON.stringify(await response.json(), null, 2)}\n`);
}

main().catch((error: unknown) => exitOnStartupError(error));
