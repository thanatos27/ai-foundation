import { CredentialError } from '../errors.js';
import type { CredentialProvider, GoogleOAuthCredentials } from './types.js';

type Env = Readonly<Record<string, string | undefined>>;

/** Reads credentials from environment variables. Only the entry point passes `process.env` here. */
export class EnvCredentialProvider implements CredentialProvider {
  constructor(private readonly env: Env) {}

  async getTodoistApiToken(): Promise<string> {
    return this.require('Todoist', ['TODOIST_API_TOKEN'])[0];
  }

  async getGoogleOAuthCredentials(): Promise<GoogleOAuthCredentials> {
    const [clientId, clientSecret, refreshToken] = this.require('Google Calendar', [
      'GOOGLE_OAUTH_CLIENT_ID',
      'GOOGLE_OAUTH_CLIENT_SECRET',
      'GOOGLE_OAUTH_REFRESH_TOKEN',
    ]);
    return { clientId, clientSecret, refreshToken };
  }

  async getNotionApiToken(): Promise<string> {
    return this.require('Notion', ['NOTION_API_TOKEN'])[0];
  }

  /** Returns the values in order, or throws naming every missing variable (never a value). */
  private require<const N extends readonly string[]>(provider: string, names: N): { [K in keyof N]: string } {
    const missing = names.filter((name) => !this.env[name]?.trim());
    if (missing.length > 0) {
      throw new CredentialError(`${provider} credential is not configured: set ${missing.join(', ')}`);
    }
    return names.map((name) => this.env[name]!.trim()) as { [K in keyof N]: string };
  }
}
