export function normalizeQuestion(text) {
  if (!text || typeof text !== 'string') return '';

  return text
    .toLowerCase()
    .trim()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export default normalizeQuestion;
