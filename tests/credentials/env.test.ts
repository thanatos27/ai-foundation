import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvCredentialProvider } from '../../src/credentials/env.js';
import { CredentialError } from '../../src/errors.js';

const google = {
  GOOGLE_OAUTH_CLIENT_ID: 'client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
  GOOGLE_OAUTH_REFRESH_TOKEN: 'refresh-token',
};

async function credentialError(promise: Promise<unknown>): Promise<CredentialError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CredentialError);
  return error as CredentialError;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('EnvCredentialProvider', () => {
  it('reads the Todoist API token', async () => {
    const provider = new EnvCredentialProvider({ TODOIST_API_TOKEN: ' secret-token\n' });
    await expect(provider.getTodoistApiToken()).resolves.toBe('secret-token');
  });

  it('reads the Google OAuth credentials', async () => {
    const provider = new EnvCredentialProvider(google);
    await expect(provider.getGoogleOAuthCredentials()).resolves.toEqual({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
    });
  });

  it.each([
    ['unset', {}],
    ['empty', { TODOIST_API_TOKEN: '' }],
    ['blank', { TODOIST_API_TOKEN: '   ' }],
  ])('reports a %s Todoist token by variable name', async (_label, env) => {
    const error = await credentialError(new EnvCredentialProvider(env).getTodoistApiToken());
    expect(error.code).toBe('credential');
    expect(error.message).toBe('Credential error: Todoist credential is not configured: set TODOIST_API_TOKEN');
  });

  it('names every missing Google variable without leaking the ones that are set', async () => {
    const env = { GOOGLE_OAUTH_CLIENT_ID: 'client-id', GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret' };
    const error = await credentialError(new EnvCredentialProvider(env).getGoogleOAuthCredentials());
    expect(error.message).toContain('set GOOGLE_OAUTH_REFRESH_TOKEN');
    expect(error.message).not.toContain('GOOGLE_OAUTH_CLIENT_ID');
    expect(error.message).not.toContain('client-secret');
  });

  it('reads the environment it was given, not process.env', async () => {
    vi.stubEnv('TODOIST_API_TOKEN', 'from-process-env');
    await credentialError(new EnvCredentialProvider({}).getTodoistApiToken());
  });
});
