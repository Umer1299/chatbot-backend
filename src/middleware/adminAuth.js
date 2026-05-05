export function requireAdminKey(req, res, next) {
  if (!process.env.ADMIN_API_KEY) {
    console.error('[adminAuth] ADMIN_API_KEY not configured')
    return res.status(500).json({ error: 'Server configuration error' })
  }

  const key = req.headers['x-admin-key']

  if (!key || key !== process.env.ADMIN_API_KEY) {
    console.warn('[adminAuth] Unauthorized attempt', {
      ip: req.ip,
      path: req.path,
      timestamp: new Date().toISOString()
    })
    return res.status(401).json({ error: 'Admin access required' })
  }

  next()
}
