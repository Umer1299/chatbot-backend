import { timingSafeEqual } from 'node:crypto';

export function requireAdminKey(req, res, next) {
  if (!process.env.ADMIN_API_KEY) {
    console.error('[adminAuth] ADMIN_API_KEY not configured')
    return res.status(500).json({ error: 'Server configuration error' })
  }

  const key = req.headers['x-admin-key']

  if (typeof key !== 'string' || Buffer.byteLength(key) !== Buffer.byteLength(process.env.ADMIN_API_KEY) ||
      !timingSafeEqual(Buffer.from(key), Buffer.from(process.env.ADMIN_API_KEY))) {
    console.warn('[adminAuth] Unauthorized attempt', {
      ip: req.ip,
      path: req.path,
      timestamp: new Date().toISOString()
    })
    return res.status(401).json({ error: 'Admin access required' })
  }

  next()
}
