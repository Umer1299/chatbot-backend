import multer from 'multer';

// The legacy form has one optional text field and at most three file parts.
// JSON text ingestion is subject to Express's existing 100 KiB JSON limit.
export const upsertUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024,
    files: 3,
    fields: 1,
    // Busboy emits partsLimit when the count reaches this value; leave one
    // sentinel slot so the fourth valid part completes before rejecting #5.
    parts: 5,
    fieldNameSize: 32,
    fieldSize: 100 * 1024,
    fieldArrayIndexLimit: 0,
  },
});

// Supplemental file ingestion has no form fields and processes one 5 MiB file.
export const supplementUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1,
    fields: 0,
    parts: 2,
    fieldNameSize: 32,
    fieldSize: 100 * 1024,
    fieldArrayIndexLimit: 0,
  },
});

export function blockStagingLegacyUploads(req, res, next) {
  if (process.env.CHATFLOW_ENVIRONMENT === 'isolated-staging' &&
      process.env.STAGING_DISABLE_LEGACY_FILE_UPLOADS === 'true') {
    return res.status(403).json({ error: 'Legacy file uploads disabled in staging' });
  }
  return next();
}

export function blockStagingMultipartUploads(req, res, next) {
  if (!req.is('multipart')) return next();
  return blockStagingLegacyUploads(req, res, next);
}

export function multipartErrorHandler(error, req, res, next) {
  if (!(error instanceof multer.MulterError)) {
    if (/^(Multipart: Boundary not found|Unexpected end of form|Unexpected end of file|Malformed part header)$/.test(error.message)) {
      return res.status(400).json({ error: 'Invalid multipart upload' });
    }
    return next(error);
  }
  const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
  return res.status(status).json({ error: 'Invalid multipart upload', code: error.code });
}
