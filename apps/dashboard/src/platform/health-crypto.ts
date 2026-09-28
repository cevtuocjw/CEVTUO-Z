/**
 * Opening the sealed health index in the browser — WITHOUT WebCrypto.
 *
 * ⚠️⚠️ Why this does not use `crypto.subtle`, which is the obvious choice.
 *
 * `crypto.subtle` exists only in a **secure context**: HTTPS, or localhost.
 * The site is served over plain HTTP (`apps.cevtuogrnd.com` has no certificate —
 * GitHub Pages reports `https_certificate: None`, and with a CNAME configured
 * it redirects the `github.io` address back to that same HTTP origin, so there
 * is no HTTPS route at all). On that origin `crypto.subtle` is `undefined`.
 *
 * ⚠️ And this was invisible for hours because of how it was tested: the local
 * verification server runs on `http://127.0.0.1:8096`, and **localhost IS a
 * secure context**. Every local run passed. The live page failed with
 * `Cannot read properties of undefined (reading 'importKey')` — a message that
 * names the symptom and hides the cause.
 *
 * ⚠️ Fetching the ciphertext from an HTTPS URL does not help: the availability
 * of `crypto.subtle` depends on the PAGE's origin, not the request's target.
 *
 * So the crypto is pure JavaScript, from `@noble/*` — audited, dependency-free,
 * and small. Measured cost on this machine: **121 ms for the 200 000 PBKDF2
 * iterations** against 22 ms for WebCrypto. Fine for a payload fetched once per
 * page load, and it is the same code on every origin.
 *
 * ⚠️ Security is NOT weakened by the page being HTTP. The passphrase never
 * leaves the browser — it is read from the URL fragment, which browsers do not
 * transmit — so an eavesdropper sees ciphertext and nothing else.
 */

import { gcm } from '@noble/ciphers/aes.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';

export interface SealedIndex {
  v: number;
  kdf: string;
  iter: number;
  salt: string;
  iv: string;
  ct: string;
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * ⚠️ Throws on a wrong passphrase, and that is the only signal available —
 * AES-GCM is authenticated, so a bad key fails the tag check rather than
 * returning garbage. The caller must not catch this into an empty index:
 * "wrong password" and "no data" would then look identical on the page.
 */
export function openSealed(sealedJson: string, passphrase: string): string {
  const env = JSON.parse(sealedJson) as SealedIndex;
  if (!env || env.v !== 1 || !env.ct) throw new Error('信封格式不认识');

  // ⚠️ `env.iter` from the file, not a constant: the number travels with the
  // payload so that raising it on the server cannot make old files unreadable.
  const key = pbkdf2(sha256, passphrase, fromB64(env.salt), { c: env.iter, dkLen: 32 });
  const plain = gcm(key, fromB64(env.iv)).decrypt(fromB64(env.ct));
  return new TextDecoder().decode(plain);
}
