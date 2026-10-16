const HTTP_PROTOCOLS = new Set(['http:', 'https:']);

export function parseHttpOrigin(value) {
  if (
    typeof value !== 'string' ||
    !/^https?:\/\/[^/?#@]+\/?$/i.test(value) ||
    /[\s\\]/.test(value)
  )
    return null;
  try {
    const url = new URL(value);
    if (
      !HTTP_PROTOCOLS.has(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      !url.hostname
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

function parseRule(value) {
  const rule = value.trim();
  const match = /^(?:(https?):\/\/)?\*\.([^/]+)$/.exec(rule);
  if (match) {
    const url = parseHttpOrigin(`${match[1] || 'https'}://${match[2]}`);
    if (!url || url.hostname.includes('*')) return null;
    return {
      wildcard: true,
      host: url.hostname,
      port: url.port,
      protocol: match[1] ? url.protocol : null,
    };
  }
  const url = parseHttpOrigin(rule);
  return url && !url.hostname.includes('*')
    ? { wildcard: false, origin: url.origin }
    : null;
}

export function matchesOrigin(origin, configuredRule) {
  const url = parseHttpOrigin(origin);
  const rule = parseRule(configuredRule);
  if (!url || !rule) return false;
  if (!rule.wildcard) return url.origin === rule.origin;
  return (
    (!rule.protocol || rule.protocol === url.protocol) &&
    url.port === rule.port &&
    url.hostname.endsWith(`.${rule.host}`)
  ); // Explicit label boundary; wildcard excludes apex.
}

function publicWidgetPath(req) {
  return (
    /^\/api\/(chat|moderate)(\/|$)/i.test(req.path) ||
    (['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      /^\/api\/business\/bot-config\/[^/]+\/preview\/?$/i.test(req.path))
  );
}

export function createCorsPolicy({
  widgetOriginsRaw = '',
  dashboardOriginsRaw,
} = {}) {
  const widgetRules = widgetOriginsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // Legacy exact origins remain trusted only when a new dashboard list is absent.
  // Wildcards never grant credentialed dashboard access.
  const dashboardRules = (
    dashboardOriginsRaw === undefined ? widgetOriginsRaw : dashboardOriginsRaw
  )
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && !s.includes('*'));
  return (req, callback) => {
    const origin = req.headers.origin;
    const common = {
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'x-chatbot-token',
        'x-admin-key',
        'Origin',
      ],
    };
    if (origin === undefined)
      return callback(null, { ...common, origin: false, credentials: false });
    if (!parseHttpOrigin(origin))
      return callback(
        Object.assign(new Error('CORS: Invalid origin'), { status: 403 }),
      );
    const publicWidget = publicWidgetPath(req);
    const permitted = publicWidget
      ? widgetRules.length === 0 ||
        widgetRules.some((rule) => matchesOrigin(origin, rule))
      : dashboardRules.some((rule) => matchesOrigin(origin, rule));
    if (!permitted)
      return callback(
        Object.assign(new Error('CORS: Origin not allowed'), { status: 403 }),
      );
    return callback(null, {
      ...common,
      origin: true,
      credentials: !publicWidget,
    });
  };
}
