export class KnowledgeIngestionError extends Error {
  constructor(
    cause,
    {
      inserted = 0,
      skipped = 0,
      failed = 0,
      code = 'KNOWLEDGE_INGESTION_FAILED',
    } = {},
  ) {
    super('Knowledge ingestion failed', { cause });
    this.code = code;
    this.status = code === 'KNOWLEDGE_EMBEDDING_FAILED'
      ? 502
      : code === 'KNOWLEDGE_MUTATION_CONFLICT'
        ? 409
        : 503;
    this.result = {
      inserted,
      skipped,
      failed,
      status: inserted > 0 ? 'partial' : 'failed',
    };
  }
}

export function ingestionResult(inserted, skipped = 0) {
  return {
    inserted,
    skipped,
    status: inserted ? 'completed' : skipped ? 'skipped' : 'empty',
  };
}

export function assertIngestionResult(result, expectedCount) {
  if (
    result &&
    (['partial', 'failed'].includes(result.status) || result.failed > 0)
  ) {
    throw new KnowledgeIngestionError(
      new Error('Incomplete ingestion'),
      result,
    );
  }
  if (
    !result ||
    !Number.isInteger(result.inserted) ||
    result.inserted < 0 ||
    (expectedCount > 0 &&
      result.inserted === 0 &&
      !(result.skipped >= expectedCount))
  ) {
    throw new KnowledgeIngestionError(new Error('No chunks were ingested'), {
      failed: expectedCount,
    });
  }
  return result;
}

export function ingestionErrorPayload(error) {
  return {
    success: false,
    error: 'Knowledge ingestion failed. Please retry.',
    code: error.code || 'KNOWLEDGE_INGESTION_FAILED',
    ...(error.result ? { ingestion: error.result } : {}),
  };
}
