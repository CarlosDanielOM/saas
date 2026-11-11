/**
 * Incremental `text/event-stream` parser for the assistant's turn events
 * (`GET /agent/:channelID/turns/:tid/events`). Pure and import-free so it can be tested in Node.
 *
 * Handles `id:`, `event:`, `data:` (multi-line), comments (`: ping`), CRLF/CR/LF line ends and
 * frames split across chunks. EventSource can't send the Bearer header, so the client reads the
 * stream with fetch and feeds the decoded text here.
 */

export interface SseFrame {
  /** `id:` of this frame (the turn cursor), or null when the frame had none. */
  id: string | null;
  /** `event:` name; `message` when the frame had none. */
  event: string;
  data: string;
}

export interface SseFeedResult {
  frames: SseFrame[];
  /** Comment lines seen (keep-alive pings). */
  comments: number;
}

export class SseParser {
  private buffer = '';
  private id: string | null = null;
  private event = '';
  private data: string[] = [];

  feed(chunk: string): SseFeedResult {
    const result: SseFeedResult = { frames: [], comments: 0 };
    this.buffer += chunk;
    let start = 0;
    for (let index = 0; index < this.buffer.length; index++) {
      const char = this.buffer[index];
      if (char !== '\n' && char !== '\r') continue;
      // A CR at the very end may be the first half of CRLF: wait for the next chunk.
      if (char === '\r' && index === this.buffer.length - 1) break;
      this.line(this.buffer.slice(start, index), result);
      if (char === '\r' && this.buffer[index + 1] === '\n') index++;
      start = index + 1;
    }
    this.buffer = this.buffer.slice(start);
    return result;
  }

  /** Drop a half-read frame (after a reconnect). */
  reset(): void {
    this.buffer = '';
    this.id = null;
    this.event = '';
    this.data = [];
  }

  private line(line: string, result: SseFeedResult): void {
    if (line === '') {
      if (this.data.length || this.event || this.id !== null) {
        result.frames.push({ id: this.id, event: this.event || 'message', data: this.data.join('\n') });
      }
      this.id = null;
      this.event = '';
      this.data = [];
      return;
    }
    if (line.startsWith(':')) {
      result.comments++;
      return;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.event = value;
    else if (field === 'id' && !value.includes('\u0000')) this.id = value;
  }
}
