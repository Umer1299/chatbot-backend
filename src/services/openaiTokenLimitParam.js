export function getOpenAITokenLimitParam(modelId, maxTokens) {
  const model = String(modelId || '').toLowerCase();

  const usesMaxCompletionTokens =
    model.startsWith('gpt-5') ||
    model.startsWith('o1') ||
    model.startsWith('o3') ||
    model.startsWith('o4');

  if (usesMaxCompletionTokens) {
    return { tokenParamName: 'max_completion_tokens', tokenParam: { max_completion_tokens: maxTokens } };
  }

  return { tokenParamName: 'max_tokens', tokenParam: { max_tokens: maxTokens } };
}
