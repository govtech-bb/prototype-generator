/**
 * Small HTTP helpers shared across routes.
 *
 * Right now this only contains `forwardAnthropicError` — when the Anthropic
 * SDK throws a 429 (rate-limited) or 529 (overloaded) error, we surface it
 * to the browser as an HTTP 429 with a `Retry-After` header so the client
 * can back off and retry sensibly. The SDK already auto-retries twice; by
 * the time we catch here, the upstream has been persistently unavailable.
 */

/**
 * If `err` is an Anthropic 429 or 529 error, write an HTTP 429 response and
 * return true. Otherwise, return false so the caller can fall through to a
 * generic 500.
 *
 * @param {any} err  — the caught error
 * @param {import('express').Response} res
 * @returns {boolean} — whether the error was handled
 */
function forwardAnthropicError(err, res) {
  const status = err && (err.status || err.statusCode);
  if (status !== 429 && status !== 529) return false;

  const upstream = err.headers && (err.headers['retry-after'] || err.headers['Retry-After']);
  const retryAfter = upstream || (status === 529 ? '60' : '30');
  res.set('Retry-After', String(retryAfter));
  res.status(429).json({
    success: false,
    rateLimited: true,
    retryAfter: Number(retryAfter) || 30,
    error: status === 529
      ? 'Anthropic is currently overloaded. Please retry in a moment.'
      : 'Anthropic rate limit reached. Please retry shortly.',
  });
  return true;
}

module.exports = { forwardAnthropicError };
