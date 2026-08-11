const crypto = require('crypto');

const { transaction } = require('../db');
const { sendVerificationEmail } = require('./mailer');

const CODE_SECRET = process.env.AUTH_CODE_SECRET;
if (!CODE_SECRET || Buffer.byteLength(CODE_SECRET, 'utf8') < 32) {
  throw new Error('AUTH_CODE_SECRET 必须是至少 32 字节的随机字符串');
}
if (CODE_SECRET === process.env.JWT_SECRET) {
  throw new Error('AUTH_CODE_SECRET 不能与 JWT_SECRET 相同');
}

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_INTERVAL_MS = 60 * 1000;
const SEND_WINDOW_MS = 60 * 60 * 1000;
const EMAIL_SEND_LIMIT = 5;
const IP_SEND_LIMIT = 20;
const MAX_ATTEMPTS = 5;

class VerificationError extends Error {
  constructor(status, message, code, retryAfter = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

function generateCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function hashCode(email, purpose, code) {
  return crypto.createHmac('sha256', CODE_SECRET)
    .update(`${purpose}\n${email}\n${code}`)
    .digest('hex');
}

function codesMatch(expected, actual) {
  const left = Buffer.from(expected, 'hex');
  const right = Buffer.from(actual, 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function reserveChallenge({ email, purpose, ip, deliver }) {
  const now = Date.now();
  const code = generateCode();
  const codeHash = hashCode(email, purpose, code);
  const id = await transaction(async (tx) => {
    const latest = await tx.get(
      `SELECT sent_at FROM verification_challenges
       WHERE provider = 'email' AND provider_subject = ? AND purpose = ?
         AND status != 'failed'
       ORDER BY sent_at DESC LIMIT 1`,
      [email, purpose]
    );
    if (latest && now - latest.sent_at < RESEND_INTERVAL_MS) {
      const retryAfter = Math.max(1, Math.ceil((RESEND_INTERVAL_MS - (now - latest.sent_at)) / 1000));
      throw new VerificationError(429, '验证码发送过于频繁，请稍后再试', 'CODE_SEND_TOO_FREQUENT', retryAfter);
    }
    const windowStart = now - SEND_WINDOW_MS;
    const emailCount = await tx.get(
      `SELECT COUNT(*) AS count FROM verification_challenges
       WHERE provider = 'email' AND provider_subject = ? AND created_at >= ? AND status != 'failed'`,
      [email, windowStart]
    );
    const ipCount = await tx.get(
      `SELECT COUNT(*) AS count FROM verification_challenges
       WHERE requester_ip = ? AND created_at >= ? AND status != 'failed'`,
      [ip, windowStart]
    );
    if (emailCount.count >= EMAIL_SEND_LIMIT || ipCount.count >= IP_SEND_LIMIT) {
      throw new VerificationError(429, '验证码发送次数过多，请稍后再试', 'CODE_SEND_LIMITED', 3600);
    }
    const result = await tx.run(
      `INSERT INTO verification_challenges(
         provider, provider_subject, purpose, code_hash, requester_ip, status,
         attempts, expires_at, sent_at, created_at
       ) VALUES ('email', ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [email, purpose, codeHash, ip, deliver ? 'pending' : 'suppressed', now + CODE_TTL_MS, now, now]
    );
    return result.lastID;
  });
  return { id, code };
}

async function requestVerificationCode({ email, purpose, ip, deliver }) {
  const startedAt = Date.now();
  const challenge = await reserveChallenge({ email, purpose, ip, deliver });
  if (deliver) {
    try {
      await sendVerificationEmail({ to: email, code: challenge.code, purpose, expiresMinutes: 10 });
      await transaction(async (tx) => {
        await tx.run(
          `UPDATE verification_challenges SET status = 'superseded'
           WHERE provider = 'email' AND provider_subject = ? AND purpose = ?
             AND status = 'active' AND id != ?`,
          [email, purpose, challenge.id]
        );
        await tx.run("UPDATE verification_challenges SET status = 'active' WHERE id = ? AND status = 'pending'", [challenge.id]);
      });
    } catch (err) {
      await transaction((tx) => tx.run("UPDATE verification_challenges SET status = 'failed' WHERE id = ?", [challenge.id]));
      throw new VerificationError(503, '验证码邮件发送失败，请稍后再试', 'MAIL_DELIVERY_FAILED');
    }
  }
  const remaining = 350 - (Date.now() - startedAt);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

async function consumeVerificationCode({ email, purpose, code }, work) {
  const now = Date.now();
  const result = await transaction(async (tx) => {
    const challenge = await tx.get(
      `SELECT id, code_hash, attempts, expires_at FROM verification_challenges
       WHERE provider = 'email' AND provider_subject = ? AND purpose = ? AND status = 'active'
       ORDER BY id DESC LIMIT 1`,
      [email, purpose]
    );
    if (!challenge || challenge.expires_at <= now || challenge.attempts >= MAX_ATTEMPTS) {
      return { invalid: true };
    }
    const suppliedHash = hashCode(email, purpose, code);
    if (!codesMatch(challenge.code_hash, suppliedHash)) {
      const attempts = challenge.attempts + 1;
      await tx.run(
        "UPDATE verification_challenges SET attempts = ?, status = CASE WHEN ? >= ? THEN 'locked' ELSE status END WHERE id = ?",
        [attempts, attempts, MAX_ATTEMPTS, challenge.id]
      );
      return { invalid: true };
    }
    const value = await work(tx);
    await tx.run(
      "UPDATE verification_challenges SET status = 'consumed', consumed_at = ? WHERE id = ? AND status = 'active'",
      [now, challenge.id]
    );
    return { value };
  });
  if (result.invalid) throw new VerificationError(400, '验证码无效或已过期', 'INVALID_VERIFICATION_CODE');
  return result.value;
}

async function cleanupVerificationChallenges(maxAgeMs = 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - maxAgeMs;
  return transaction((tx) => tx.run('DELETE FROM verification_challenges WHERE created_at < ?', [cutoff]));
}

module.exports = {
  VerificationError,
  requestVerificationCode,
  consumeVerificationCode,
  cleanupVerificationChallenges,
};
