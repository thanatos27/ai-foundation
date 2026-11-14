import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { expect } from 'vitest';
import type { Config } from '../../src/config/schema.js';
import type { Connectors } from '../../src/connectors/types.js';
import { createHttpApp } from '../../src/http/app.js';
import { repoConfig } from './mcp.js';

/** The key every test app accepts (32+ printable ASCII characters). */
export const TEST_API_KEY = 'test-api-key-0123456789abcdefghijklmnop';

export type TestApp = ReturnType<typeof createHttpApp>;

export interface TestAppOptions {
  config?: Config;
  /** Unexpected errors the app reported (500s), instead of writing them to stderr. */
  errors?: unknown[];
}

export function createTestApp(connectors: Connectors, { config = repoConfig, errors = [] }: TestAppOptions = {}): TestApp {
  return createHttpApp({ config, connectors, apiKey: TEST_API_KEY, logError: (error) => errors.push(error) });
}

export interface CallOptions {
  /** Query parameters; arrays become repeated keys. Values are encoded as a browser would. */
  query?: Record<string, string | string[]>;
  /** JSON body (`undefined`: none). A string is sent as is. */
  body?: unknown;
  /** API key to send; `null` sends no Authorization header. Defaults to the test key. */
  key?: string | null;
  headers?: Record<string, string>;
}

export interface CallResult {
  status: number;
  headers: Headers;
  body: any;
  text: string;
}

/** Sends one request through `app.request()`: no network. */
export async function call(app: TestApp, method: string, path: string, options: CallOptions = {}): Promise<CallResult> {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(options.query ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) params.append(name, item);
  }
  // URLSearchParams writes spaces as "+", which a query reads back as a space; encode like encodeURIComponent.
  const search = params.size > 0 ? `?${params.toString().replaceAll('+', '%20')}` : '';
  const headers: Record<string, string> = { ...options.headers };
  const key = options.key === undefined ? TEST_API_KEY : options.key;
  if (key !== null) headers.Authorization = `Bearer ${key}`;
  let body: string | undefined;
  if (options.body !== undefined) {
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    headers['Content-Type'] ??= 'application/json';
  }
  const response = await app.request(`${path}${search}`, { method, headers, ...(body === undefined ? {} : { body }) });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text === '' ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { status: response.status, headers: response.headers, body: parsed, text };
}

/** `/v1/...` with the id URL-encoded as a client should. */
export const withId = (prefix: string, id: string, suffix = '') => `${prefix}/${encodeURIComponent(id)}${suffix}`;

// ---- OpenAPI conformance --------------------------------------------------------------------

type OpenApiDocument = {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, unknown>; securitySchemes?: Record<string, unknown> };
};

const documents = new WeakMap<TestApp, OpenApiDocument>();

/** The app's /openapi.json, fetched once per app. */
export async function openApiDocument(app: TestApp): Promise<OpenApiDocument> {
  let document = documents.get(app);
  if (!document) {
    const { status, body } = await call(app, 'GET', '/openapi.json');
    expect(status).toBe(200);
    document = body as OpenApiDocument;
    documents.set(app, document);
  }
  return document;
}

/**
 * Checks a response against the schema the document declares for that operation and status, with a
 * JSON Schema validator independent of Zod, so that the document and the real API cannot drift apart.
 */
export async function expectConformsToDocument(
  app: TestApp,
  method: string,
  templatePath: string,
  result: CallResult,
): Promise<void> {
  const document = await openApiDocument(app);
  const operation = document.paths[templatePath]?.[method.toLowerCase()];
  expect(operation, `${method} ${templatePath} is in the document`).toBeDefined();
  const declared = operation.responses[String(result.status)];
  expect(declared, `${method} ${templatePath} declares status ${result.status}`).toBeDefined();
  const schema = declared.content['application/json'].schema;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats.default(ajv);
  const validate = ajv.compile({ ...schema, components: document.components, $id: 'https://ai-foundation.test/response' });
  const valid = validate(result.body);
  expect(valid, JSON.stringify(validate.errors)).toBe(true);
}
