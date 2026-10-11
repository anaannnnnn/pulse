// OpenSubtitles/TPDB "OSHASH": file size + 64-bit little-endian word sum of the first and last 64 KiB, mod 2^64, as 16 hex chars.
export const OSHASH_CHUNK = 65536;
export function oshash(size: number, head: Uint8Array, tail: Uint8Array): string | null {
  if (size < OSHASH_CHUNK * 2 || head.length < OSHASH_CHUNK || tail.length < OSHASH_CHUNK) return null;
  const M = (1n << 64n) - 1n;
  let h = BigInt(size) & M;
  for (const buf of [head, tail]) {
    const dv = new DataView(buf.buffer, buf.byteOffset, OSHASH_CHUNK);
    for (let i = 0; i < OSHASH_CHUNK; i += 8) h = (h + dv.getBigUint64(i, true)) & M;
  }
  return h.toString(16).padStart(16, '0');
}

/** Computes OSHASH of a remote file via two HTTP Range requests (128 KiB total). */
export async function oshashFromUrl(url: string, size: number, f: typeof fetch = fetch): Promise<string | null> {
  if (!size || size < OSHASH_CHUNK * 2) return null;
  const range = async (a: number, b: number) => {
    const r = await f(url, { headers: { Range: `bytes=${a}-${b}` } });
    if (r.status !== 206 && r.status !== 200) throw new Error(`range HTTP ${r.status}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    return r.status === 200 ? buf.slice(a, b + 1) : buf; // a server that ignores Range returns everything
  };
  const head = await range(0, OSHASH_CHUNK - 1);
  const tail = await range(size - OSHASH_CHUNK, size - 1);
  return oshash(size, head, tail);
}
