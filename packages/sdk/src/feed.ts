/**
 * Server-Sent Events from a byte stream: `event:` and `data:` lines, blank-line separated.
 * Comments (`: keep-alive`) are skipped; multi-line data is joined with newlines; CRLF is fine.
 * No dependency, so it runs in Node, Bun, Deno and edge runtimes.
 */
export async function* parseEvents(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = '';
  let event = 'message';
  let data: string[] = [];
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.search(/\r?\n/)) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + (buffer.charAt(newline) === '\r' ? 2 : 1));
      if (line === '') {
        if (data.length > 0) yield { event, data: data.join('\n') };
        event = 'message';
        data = [];
      } else if (line.startsWith(':')) {
        continue;
      } else {
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
    }
  }
}
