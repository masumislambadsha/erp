import argon2 from 'argon2';

// OWASP argon2id minimum: 19 MiB, 2 iterations, 1 lane.
const OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128; // bounds the work an attacker can make us do

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function needsRehash(hash: string): boolean {
  return argon2.needsRehash(hash, OPTIONS);
}

let dummy: Promise<string> | undefined;
/** Verified against when an email matches nobody, so unknown and known emails take equally long. */
export function verifyAgainstDummy(password: string): Promise<boolean> {
  dummy ??= hashPassword('dummy-password-for-timing');
  return dummy.then((h) => verifyPassword(h, password));
}

/** Returns a reason if the password is not acceptable. */
export function passwordProblem(password: string, email: string): string | null {
  if (password.length < PASSWORD_MIN) return `must be at least ${PASSWORD_MIN} characters`;
  if (password.length > PASSWORD_MAX) return `must be at most ${PASSWORD_MAX} characters`;
  if (password.toLowerCase() === email.toLowerCase()) return 'must not be your email';
  return null;
}
