export function cleanAndChunkContent(pages = []) {
  if (!Array.isArray(pages)) return [];

  return pages
    .map((page, index) => ({
      id: `owner_chunk_${index + 1}`,
      content: typeof page?.content === 'string' ? page.content.trim() : '',
      metadata: {
        url: page?.url || '',
        title: page?.title || '',
      },
    }))
    .filter((chunk) => chunk.content.length > 0);
}

export function shouldEmbedChunk(chunk) {
  const text = typeof chunk?.content === 'string' ? chunk.content.trim() : '';
  return text.length >= 20;
}
