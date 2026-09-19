import crypto from 'crypto';

// SHA-256 hex digest of a UTF-8 string. Used for secrets stored only as hashes at rest (deploy keys,
// GitHub webhook path tokens, API keys) so a database breach never exposes usable credentials.
export const sha256Hex = (raw: string): string => crypto.createHash('sha256').update(raw).digest('hex');

// Constant-time comparison of a raw secret's hash against a stored hash. Returns false on any length
// mismatch (which timingSafeEqual would otherwise throw on).
export const hashEquals = (raw: string, storedHash: string): boolean => {
    if (!storedHash) return false;
    const a = Buffer.from(sha256Hex(raw));
    const b = Buffer.from(storedHash);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
};
