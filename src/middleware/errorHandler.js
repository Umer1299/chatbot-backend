export function globalErrorHandler(err, req, res, next) {
  const isDev = process.env.NODE_ENV !== 'production';

  console.error('[UNHANDLED]', {
    method: req.method,
    path: req.path,
    status: err.status || 500,
    message: err.message,
    stack: isDev ? err.stack : '[hidden]'
  });

  if (res.headersSent) {
    return next(err);
  }

  res.status(err.status || 500).json({
    error: isDev ? err.message : 'Something went wrong. Please try again.'
  });
}
