export function buildAnthropicPayload(systemPrompt, messages = []) {
  const systemParts = [];
  if (typeof systemPrompt === 'string' && systemPrompt.trim().length > 0) {
    systemParts.push(systemPrompt.trim());
  }

  const sanitizedMessages = [];
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role;
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (role === 'system') {
      if (content.trim().length > 0) systemParts.push(content.trim());
      continue;
    }
    if (role === 'user' || role === 'assistant') {
      sanitizedMessages.push({ role, content });
    }
  }

  while (sanitizedMessages.length > 0 && sanitizedMessages[0].role === 'assistant') {
    sanitizedMessages.shift();
  }

  return {
    system: systemParts.join('\n\n').trim(),
    messages: sanitizedMessages
  };
}
