'use strict';

const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

const {
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM,
  SMTP_FROM_NAME,
  NODE_ENV,
} = process.env;

// Create transporter
const transporter = nodemailer.createTransport({
  host: SMTP_HOST || 'smtpout.secureserver.net',
  port: parseInt(SMTP_PORT) || 465,
  secure: SMTP_SECURE === 'true',
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS,
  },
  tls: {
    rejectUnauthorized: false, // GoDaddy compatibility
    minVersion: 'TLSv1.2',
  },
  pool: true,
  maxConnections: 5,
  maxMessages: 100,
  rateDelta: 1000,
  rateLimit: 5,
});

// Verify connection on startup
const verifyConnection = async () => {
  if (NODE_ENV === 'test') return true;
  try {
    await transporter.verify();
    logger.info('SMTP connection verified successfully');
    return true;
  } catch (error) {
    logger.error('SMTP connection failed:', error.message);
    return false;
  }
};

/**
 * Send an email
 * @param {object} options
 * @param {string} options.to - Recipient email
 * @param {string} options.subject - Email subject
 * @param {string} options.html - HTML body
 * @param {string} [options.text] - Plain text fallback
 * @param {Array} [options.attachments] - Nodemailer attachments array
 * @returns {Promise<object>} Nodemailer info object
 */
const sendEmail = async ({ to, subject, html, text, attachments = [] }) => {
  if (NODE_ENV === 'test') {
    logger.info(`[TEST] Email would be sent to: ${to} | Subject: ${subject}`);
    return { messageId: 'test-message-id' };
  }

  const mailOptions = {
    from: `"${SMTP_FROM_NAME || 'IncorERP'}" <${SMTP_FROM}>`,
    to,
    subject,
    html,
    text: text || html.replace(/<[^>]*>/g, ''),
    attachments,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    logger.info(`Email sent to ${to}: ${info.messageId}`);
    return info;
  } catch (error) {
    logger.error(`Failed to send email to ${to}:`, error.message);
    throw error;
  }
};

/**
 * HTML email template wrapper
 * @param {string} content - HTML content
 * @param {string} title - Email title
 * @returns {string} Full HTML email
 */
const emailTemplate = (content, title = 'IncorERP') => `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body { font-family: Arial, sans-serif; background: #f4f4f4; margin: 0; padding: 0; }
    .container { max-width: 600px; margin: 30px auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .header { background: #1a3a6b; color: #fff; padding: 24px 32px; }
    .header h1 { margin: 0; font-size: 22px; }
    .body { padding: 32px; color: #333; line-height: 1.6; }
    .button { display: inline-block; background: #1a3a6b; color: #fff; padding: 12px 28px; border-radius: 6px; text-decoration: none; font-weight: bold; margin: 16px 0; }
    .footer { background: #f0f0f0; padding: 16px 32px; font-size: 12px; color: #888; text-align: center; }
    .divider { border: none; border-top: 1px solid #eee; margin: 24px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>IncorERP</h1>
    </div>
    <div class="body">
      ${content}
    </div>
    <div class="footer">
      <p>Este mensaje fue enviado automáticamente por IncorERP.</p>
      <p>Por favor no respondas a este correo directamente.</p>
      <p>&copy; ${new Date().getFullYear()} Incored y Asociados. Todos los derechos reservados.</p>
    </div>
  </div>
</body>
</html>
`;

module.exports = {
  transporter,
  verifyConnection,
  sendEmail,
  emailTemplate,
};
