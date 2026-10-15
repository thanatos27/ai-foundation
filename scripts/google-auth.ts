/**
 * One-off helper that obtains a Google OAuth refresh token for the Calendar connector.
 *
 *   npm run auth:google
 *
 * Needs GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET (a "Desktop app" OAuth client) in the
 * environment or the repository's .env. Opens a loopback listener on 127.0.0.1, prints the consent
 * URL, and prints the refresh token once. Nothing is written to disk: put the token into .env
 * (or the MCP client's env) as GOOGLE_OAUTH_REFRESH_TOKEN yourself.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { GOOGLE_CALENDAR_SCOPES } from '../src/connectors/google-calendar/client.js';

const TIMEOUT_MS = 5 * 60_000;

function fail(message: string): never {
  console.error(`[auth:google] ${message}`);
  process.exit(1);
}

const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
if (!clientId || !clientSecret) {
  fail('Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET (in .env or the environment) first.');
}

/** Starts the loopback listener and returns its redirect URI and the code it will receive. */
async function listenForCode(state: string): Promise<{ redirectUri: string; code: Promise<string> }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const code = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('Timed out waiting for the browser (5 minutes).'));
    }, TIMEOUT_MS);

    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      const params = new URL(req.url ?? '/', redirectUri).searchParams;
      if (!params.has('code') && !params.has('error')) {
        res.writeHead(404).end();
        return;
      }
      const received = params.get('state') === state ? params.get('code') : null;
      res.writeHead(received ? 200 : 400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(received ? 'AI Foundation: authorized. You can close this tab.' : 'AI Foundation: authorization failed.');
      clearTimeout(timer);
      server.close();
      if (received) resolve(received);
      else if (params.get('state') !== state) reject(new Error('State mismatch in the OAuth redirect.'));
      else reject(new Error(`Authorization was not granted: ${params.get('error')}`));
    });
  });
  return { redirectUri, code };
}

async function main(): Promise<void> {
  const state = randomUUID();
  const { redirectUri, code } = await listenForCode(state);

  const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GOOGLE_CALENDAR_SCOPES,
    state,
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: codeChallenge,
  });

  console.error('[auth:google] Open this URL in a browser and allow access:\n');
  console.error(authUrl);
  console.error('\n[auth:google] Waiting for the redirect...');

  const { tokens } = await client.getToken({ code: await code, codeVerifier, redirect_uri: redirectUri });
  if (!tokens.refresh_token) {
    fail('Google returned no refresh token. Revoke the app at https://myaccount.google.com/permissions and retry.');
  }

  console.error('\n[auth:google] Add this line to .env (or the MCP client env). Do not commit it.\n');
  console.log(`GOOGLE_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}`);
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
