import bcrypt from "bcryptjs";

const BCRYPT_ROUNDS = 10;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * 中等强度密码规则(初始产品规格现归档于 docs/archive/initial-spec/):
 * - 至少 8 位
 * - 至少包含字母和数字
 * - 不允许与账号相同
 */
export interface PasswordPolicyResult {
  ok: boolean;
  reason?: string;
}

export function validatePasswordPolicy(
  plain: string,
  username: string
): PasswordPolicyResult {
  if (plain.length < 8) {
    return { ok: false, reason: "密码至少需要 8 位" };
  }
  if (!/[A-Za-z]/.test(plain)) {
    return { ok: false, reason: "密码至少需要包含字母" };
  }
  if (!/\d/.test(plain)) {
    return { ok: false, reason: "密码至少需要包含数字" };
  }
  if (plain === username) {
    return { ok: false, reason: "密码不能与账号相同" };
  }
  return { ok: true };
}

/**
 * 生成 12 位的临时密码,满足字母+数字规则。
 */
export function generateTemporaryPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz";
  const digits = "23456789";
  const all = alphabet + digits;
  // 至少 4 字母 + 4 数字 + 4 随机
  let pw = "";
  for (let i = 0; i < 4; i++) pw += alphabet[cryptoRandomInt(alphabet.length)];
  for (let i = 0; i < 4; i++) pw += digits[cryptoRandomInt(digits.length)];
  for (let i = 0; i < 4; i++) pw += all[cryptoRandomInt(all.length)];
  return shuffle(pw);
}

function cryptoRandomInt(maxExclusive: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % maxExclusive;
}

function shuffle(input: string): string {
  const arr = Array.from(input);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = cryptoRandomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.join("");
}
