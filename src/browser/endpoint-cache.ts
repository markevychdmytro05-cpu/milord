// Some Local APIs cannot tell whether a profile is open. Remember the endpoint start() returned
// and ask the browser's own debug port whether it still answers.
const open = new Map<string, string>();

export function rememberEndpoint(key: string, endpoint: string): void { open.set(key, endpoint); }

export async function liveEndpoint(key: string, signal: AbortSignal, request: typeof fetch): Promise<string | undefined> {
  const endpoint = open.get(key);
  if (!endpoint) return undefined;
  try {
    const { port } = new URL(endpoint);
    const response = await request(new URL(`http://127.0.0.1:${port}/json/version`),
      { signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]), redirect: 'error' });
    if (response.ok) return endpoint;
  } catch { if (signal.aborted) throw signal.reason; }
  open.delete(key);
  return undefined;
}
