import crypto from 'node:crypto';

export function createRawToken() {
  return `tmag_${crypto.randomBytes(32).toString('base64url')}`;
}

export function hashToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function tokenPrefix(token: string) {
  return `${token.slice(0, 13)}...`;
}
