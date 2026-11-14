/**
 * How file bytes become text, shared by every storage (file system, Google Drive) so that both read
 * a note the same way. A byte order mark is dropped either way.
 */

const BOM = /^﻿/;

/** Knowledge: bytes that are not UTF-8 become U+FFFD instead of an error (as readFile(…, 'utf8')). */
export function decodeLenient(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8').replace(BOM, '');
}

/** Life logs: bytes that are not valid UTF-8 are an error, built by `invalid` (the decoder's error is its cause). */
export function decodeStrict(bytes: Uint8Array, invalid: (cause: unknown) => Error): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw invalid(error);
  }
  return text.replace(BOM, '');
}
