import { OpenAPIHono } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import type { Config } from '../config/schema.js';
import type { Connectors } from '../connectors/types.js';
import { createOperations } from '../operations/index.js';
import { bearerAuth } from './auth.js';
import { errorBody, issuesMessage, toHttpError } from './errors.js';
import { DOCUMENT_CONFIG, MAX_BODY_BYTES, SECURITY_SCHEME } from './openapi.js';
import { registerRoutes } from './routes/index.js';

export interface HttpAppOptions {
  config: Config;
  connectors: Connectors;
  /** Already validated (`parseApiKey`); the only key that is accepted. */
  apiKey: string;
  /** Where unexpected errors are reported. Defaults to stderr. */
  logError?: (error: unknown) => void;
}

/**
 * Builds the REST API. No I/O: config is loaded and the key validated by the caller, and connectors
 * are reached only when a route runs. Every request is authenticated first, so nothing reaches a
 * connector without the API key.
 */
export function createHttpApp({ config, connectors, apiKey, logError }: HttpAppOptions): OpenAPIHono {
  const log = logError ?? ((error: unknown) => console.error('[ai-foundation]', error));
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) return c.json(errorBody('invalid_input', issuesMessage(result.error.issues)), 400);
    },
  });

  app.onError((error, c) => {
    const response = toHttpError(error);
    if (response.status >= 500) log(error);
    return c.json(errorBody(response.code, response.message), response.status);
  });
  app.notFound((c) => c.json(errorBody('route_not_found', `No such route: ${c.req.method} ${c.req.path}`), 404));

  app.use('*', bearerAuth(apiKey));
  app.use(
    '*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json(errorBody('payload_too_large', 'The request body is over 1 MiB'), 413),
    }),
  );

  app.openAPIRegistry.registerComponent('securitySchemes', SECURITY_SCHEME, { type: 'http', scheme: 'bearer' });
  registerRoutes(app, createOperations({ config, connectors }));

  // Generated once from the routes above; served behind the same authentication.
  const document = app.getOpenAPI31Document(DOCUMENT_CONFIG);
  app.get('/openapi.json', (c) => c.json(document));
  return app;
}
