let ready = false;

export function markApplicationReady(value) {
  ready = value === true;
}

export function isApplicationReady() {
  return ready;
}

export function createReadinessHandler({ checkDatabase, checkRedis }) {
  return async function readinessHandler(req, res) {
    if (!isApplicationReady()) return res.status(503).json({ status: 'starting' });
    try {
      await Promise.all([checkDatabase(), checkRedis()]);
      return res.status(200).json({ status: 'ready' });
    } catch {
      return res.status(503).json({ status: 'dependencies_unavailable' });
    }
  };
}
