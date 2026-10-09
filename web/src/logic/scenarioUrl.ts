import type { Scenario } from '../types';

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

/** Scenario → base64url(deflate-raw(JSON)). */
export async function encodeScenario(s: Scenario): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(s));
  return toBase64Url(await pipe(json, new CompressionStream('deflate-raw')));
}

export async function decodeScenario(code: string): Promise<Scenario> {
  const bytes = await pipe(fromBase64Url(code), new DecompressionStream('deflate-raw'));
  const s = JSON.parse(new TextDecoder().decode(bytes)) as Scenario;
  if (!s || typeof s !== 'object' || !Array.isArray(s.events)) throw new Error('not a scenario');
  return s;
}

/** Reads `#s=…` from a location hash. */
export function scenarioCodeFromHash(hash: string): string | null {
  const m = /[#&]s=([A-Za-z0-9_-]+)/.exec(hash);
  return m ? m[1] : null;
}
