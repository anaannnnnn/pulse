export type Call = { url: string; init?: any };
/** Builds a fake fetch from a route table: (url, init) => body | Response */
export function fakeFetch(handler: (url: URL, init?: any) => any) {
  const calls: Call[] = [];
  const f = (async (input: any, init?: any) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), init });
    const out = await handler(url, init);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { f, calls };
}
