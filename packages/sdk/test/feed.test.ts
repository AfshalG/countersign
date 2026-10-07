import { describe, expect, it } from 'vitest';
import { parseEvents } from '../src/feed.js';

async function* chunks(...parts: string[]) {
  const encoder = new TextEncoder();
  for (const part of parts) {
    await Promise.resolve();
    yield encoder.encode(part);
  }
}

async function collect(stream: AsyncIterable<{ event: string; data: string }>) {
  const out = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe('the feed parser (Server-Sent Events)', () => {
  it('reads events split across chunks, and skips keep-alive comments', async () => {
    const events = await collect(
      parseEvents(
        chunks(
          'event: status\nid: 1\ndata: {"id":"a",',
          '"to":"settled"}\n\n: keep-alive\n\n',
          'event: status\nid: 2\ndata: {"id":"b","to":"held"}\n\n',
        ),
      ),
    );
    expect(events).toEqual([
      { event: 'status', data: '{"id":"a","to":"settled"}' },
      { event: 'status', data: '{"id":"b","to":"held"}' },
    ]);
  });

  it('joins multi-line data and handles CRLF', async () => {
    const events = await collect(
      parseEvents(chunks('event: status\r\ndata: line 1\r\ndata: line 2\r\n\r\n')),
    );
    expect(events).toEqual([{ event: 'status', data: 'line 1\nline 2' }]);
  });
});
