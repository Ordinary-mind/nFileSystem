const nodemailer = require('nodemailer');

let transporter = null;
let consoleMode = false;
const testOutbox = [];

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function getMailConfig() {
  const port = Number.parseInt(process.env.SMTP_PORT || '587', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SMTP_PORT 必须是 1-65535 之间的整数');
  }
  const user = process.env.SMTP_USER || '';
  const pass = process.env.SMTP_PASS || '';
  if (Boolean(user) !== Boolean(pass)) throw new Error('SMTP_USER 和 SMTP_PASS 必须同时配置');
  return {
    host: process.env.SMTP_HOST || '',
    port,
    secure: parseBoolean(process.env.SMTP_SECURE, port === 465),
    auth: user ? { user, pass } : undefined,
    from: process.env.MAIL_FROM || '',
  };
}

async function initializeMailer() {
  if (process.env.NODE_ENV === 'test') return;
  const config = getMailConfig();
  if (!config.host || !config.from) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('生产环境必须配置 SMTP_HOST 和 MAIL_FROM');
    }
    consoleMode = true;
    console.warn('未配置 SMTP，开发环境将在控制台输出邮箱验证码');
    return;
  }
  transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
  await transporter.verify();
}

function getPurposeCopy(purpose) {
  if (purpose === 'register') return { subject: '注册验证码', action: '完成邮箱注册' };
  return { subject: '重置密码验证码', action: '重置账号密码' };
}

async function sendVerificationEmail({ to, code, purpose, expiresMinutes }) {
  const copy = getPurposeCopy(purpose);
  if (process.env.NODE_ENV === 'test') {
    testOutbox.push({ to, code, purpose });
    return;
  }
  if (consoleMode) {
    console.info(`[开发邮件] ${to} ${copy.subject}: ${code}`);
    return;
  }
  if (!transporter) throw new Error('邮件服务尚未初始化');
  const from = getMailConfig().from;
  await transporter.sendMail({
    from,
    to,
    subject: `nFileSystem ${copy.subject}`,
    text: `你的验证码是 ${code}，用于${copy.action}。验证码 ${expiresMinutes} 分钟内有效，请勿转发给他人。`,
    html: `<p>你的验证码是：</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p><p>用于${copy.action}，${expiresMinutes} 分钟内有效，请勿转发给他人。</p>`,
  });
}

function getTestOutbox() {
  return testOutbox.map((item) => ({ ...item }));
}

function clearTestOutbox() {
  testOutbox.length = 0;
}

module.exports = {
  initializeMailer,
  sendVerificationEmail,
  getTestOutbox,
  clearTestOutbox,
};
