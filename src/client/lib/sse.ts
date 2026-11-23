export interface SseFrame {
  event: string;
  data: unknown;
}

function dispatchBlock(block: string, onEvent: (frame: SseFrame) => void): void {
  if (!block.trim()) {
    return;
  }
  let eventName = 'message';
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trim());
    }
  }
  if (dataLines.length > 0) {
    const raw = dataLines.join('\n');
    try {
      onEvent({ event: eventName, data: JSON.parse(raw) });
    } catch {
      onEvent({ event: eventName, data: raw });
    }
  }
}

/**
 * Incrementally parses Server-Sent Events (SSE) from a Fetch Response body.
 */
export async function readSseStream(
  response: Response,
  onEvent: (frame: SseFrame) => void,
): Promise<void> {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    for (const block of text.split(/\r?\n\r?\n/)) {
      dispatchBlock(block, onEvent);
    }
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      dispatchBlock(part, onEvent);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    for (const part of buffer.split(/\r?\n\r?\n/)) {
      dispatchBlock(part, onEvent);
    }
  }
}
