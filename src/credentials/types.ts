/** OAuth 2.0 client and the user's refresh token for Google APIs. */
export interface GoogleOAuthCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/**
 * Where connectors get their secrets. Connectors never read environment variables or files
 * themselves, so the store can be swapped (e.g. for a secret manager) without touching them.
 * Each method throws `CredentialError` when its credential is not configured.
 */
export interface CredentialProvider {
  getTodoistApiToken(): Promise<string>;
  getGoogleOAuthCredentials(): Promise<GoogleOAuthCredentials>;
}
