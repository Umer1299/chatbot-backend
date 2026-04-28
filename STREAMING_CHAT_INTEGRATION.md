# Streaming `/api/chat` integration with chatbot-widget

This backend already supports streaming with Server-Sent Events (SSE) when `stream=true` is passed on the request URL.

## Backend contract

- Endpoint: `POST /api/chat?stream=true`
- Required headers:
  - `Content-Type: application/json`
  - `x-chatbot-token: <chatbot token>`
- Body:
  - `botId` (string)
  - `userId` (string, optional)
  - `sessionId` (string)
  - `message` (string)
  - optional: `model`, `systemPrompt`

## SSE event format sent by backend

The backend writes plain SSE lines of the form `data: <json>\n\n`:

1. Token chunks:
   - `{"text":"..."}`
2. Final metadata:
   - `{"type":"meta","reply":"...","creditsUsed":...,"inputTokens":...,"outputTokens":...,"model":"..."}`
3. Completion marker:
   - `[DONE]`
4. Error payload:
   - `{"type":"error","message":"..."}`

## Widget changes (`chatbot-widget`)

Because auth and request body are required, prefer `fetch` streaming instead of `EventSource`.

### 1) Send streaming request

```js
const response = await fetch(`${apiBase}/api/chat?stream=true`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-chatbot-token': token,
  },
  body: JSON.stringify({
    botId,
    userId,
    sessionId,
    message,
    model, // optional
    systemPrompt, // optional
  }),
});
```

### 2) Parse SSE incrementally

```js
const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let assistantText = '';

while (true) {
  const { value, done } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });
  const events = buffer.split('\n\n');
  buffer = events.pop() || '';

  for (const event of events) {
    if (!event.startsWith('data:')) continue;

    const raw = event.replace(/^data:\s*/, '').trim();
    if (raw === '[DONE]') {
      onComplete?.(assistantText);
      continue;
    }

    const payload = JSON.parse(raw);

    if (payload.type === 'error') {
      onError?.(payload.message);
      continue;
    }

    if (payload.text) {
      assistantText += payload.text;
      onToken?.(payload.text, assistantText);
      continue;
    }

    if (payload.type === 'meta') {
      onMeta?.(payload);
    }
  }
}
```

### 3) Render behavior in widget

- Create an empty assistant bubble immediately.
- Append each `text` chunk to the same bubble (`assistantText`).
- Stop typing indicator when `[DONE]` arrives.
- Persist final `assistantText` and `meta` to widget-side state/history.
- If `type=error`, show a retry CTA and keep original user message.

## Notes

- The backend sends keep-alive comments (`:\n\n`) every 15s.
- Reverse-proxy buffering should be disabled for this route (backend already sends `X-Accel-Buffering: no`).
- If `stream=true` is omitted, endpoint falls back to JSON response mode.
