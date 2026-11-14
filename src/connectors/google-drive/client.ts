/**
 * OAuth scopes requested by `npm run auth:google -- --drive`. `drive` can manage every file in the
 * user's Drive: it is needed because the vault holds files created by Drive for desktop and by hand,
 * which `drive.file` cannot reach. The connector itself only reads and writes the configured folders.
 */
export const GOOGLE_DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive'];
