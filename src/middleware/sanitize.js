const SANITIZE_PATTERNS = [
  /ignore (previous|above|all) instructions/gi,
  /disregard (previous|your) (instructions|prompt)/gi,
  /you are now/gi,
  /new persona/gi,
  /act as if/gi,
  /jailbreak/gi,
  /<!--[\s\S]*?-->/g,
  /<script[\s\S]*?<\/script>/gi,
  /system:/gi,
  /\[INST\]/gi,
  /\[\/INST\]/gi,
];

export function sanitizeMessage(message) {
  if (typeof message !== 'string') {
    return '';
  }

  let cleaned = message;

  for (const pattern of SANITIZE_PATTERNS) {
    cleaned = cleaned.replace(pattern, '[removed]');
  }

  cleaned = cleaned.trim();

  if (cleaned.length > 600) {
    cleaned = cleaned.slice(0, 600);
  }

  return cleaned;
}

export function sanitizeRequest(req, res, next) {
  if (req?.body?.message) {
    req.body.message = sanitizeMessage(req.body.message);
  }

  next();
}
