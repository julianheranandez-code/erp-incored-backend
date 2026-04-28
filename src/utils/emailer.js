'use strict';

const { sendEmail, emailTemplate } = require('../config/email');

/**
 * Send welcome email to new user
 */
const sendWelcomeEmail = async ({ to, name, tempPassword, loginUrl }) => {
  const content = `
    <h2>¡Bienvenido a IncorERP, ${name}!</h2>
    <p>Tu cuenta ha sido creada exitosamente. Aquí están tus credenciales de acceso:</p>
    <table style="border-collapse:collapse;margin:16px 0;">
      <tr>
        <td style="padding:8px;font-weight:bold;color:#555;">Email:</td>
        <td style="padding:8px;">${to}</td>
      </tr>
      <tr>
        <td style="padding:8px;font-weight:bold;color:#555;">Contraseña temporal:</td>
        <td style="padding:8px;font-family:monospace;font-size:16px;background:#f5f5f5;padding:4px 10px;border-radius:4px;">${tempPassword}</td>
      </tr>
    </table>
    <p><strong>⚠️ Deberás cambiar tu contraseña en tu primer inicio de sesión.</strong></p>
    <a href="${loginUrl || process.env.FRONTEND_URL + '/login'}" class="button">Ingresar al Sistema</a>
    <hr class="divider">
    <p style="color:#888;font-size:13px;">Si no reconoces esta cuenta, por favor contacta al administrador.</p>
  `;

  return sendEmail({
    to,
    subject: 'Bienvenido a IncorERP - Tu cuenta ha sido creada',
    html: emailTemplate(content, 'Bienvenido a IncorERP'),
  });
};

/**
 * Send password reset email
 */
const sendPasswordResetEmail = async ({ to, name, resetToken, resetUrl }) => {
  const url = resetUrl || `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;
  const content = `
    <h2>Restablecer contraseña</h2>
    <p>Hola ${name},</p>
    <p>Recibimos una solicitud para restablecer la contraseña de tu cuenta en IncorERP.</p>
    <p>Haz clic en el siguiente botón para crear una nueva contraseña:</p>
    <a href="${url}" class="button">Restablecer Contraseña</a>
    <p style="margin-top:24px;">O copia y pega este enlace en tu navegador:</p>
    <p style="word-break:break-all;background:#f5f5f5;padding:10px;border-radius:4px;font-size:13px;">${url}</p>
    <hr class="divider">
    <p style="color:#888;font-size:13px;">
      Este enlace expirará en <strong>1 hora</strong>.<br>
      Si no solicitaste restablecer tu contraseña, puedes ignorar este correo.
    </p>
  `;

  return sendEmail({
    to,
    subject: 'IncorERP - Restablecer contraseña',
    html: emailTemplate(content, 'Restablecer Contraseña'),
  });
};

/**
 * Send quote email to client
 */
const sendQuoteEmail = async ({ to, clientName, quoteNumber, pdfBuffer, senderName }) => {
  const content = `
    <h2>Cotización ${quoteNumber}</h2>
    <p>Estimado(a) ${clientName},</p>
    <p>Adjunto encontrará nuestra cotización <strong>${quoteNumber}</strong> preparada especialmente para usted.</p>
    <p>Quedamos a su disposición para cualquier pregunta o aclaración.</p>
    <p style="margin-top:24px;">Atentamente,<br><strong>${senderName}</strong><br>Incored y Asociados</p>
  `;

  const attachments = pdfBuffer
    ? [{ filename: `Cotizacion-${quoteNumber}.pdf`, content: pdfBuffer, contentType: 'application/pdf' }]
    : [];

  return sendEmail({
    to,
    subject: `Cotización ${quoteNumber} - Incored y Asociados`,
    html: emailTemplate(content, `Cotización ${quoteNumber}`),
    attachments,
  });
};

/**
 * Send low stock alert email
 */
const sendLowStockAlert = async ({ to, materials }) => {
  const rows = materials.map((m) =>
    `<tr>
      <td style="padding:8px;border-bottom:1px solid #eee;">${m.sku}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;">${m.name}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;color:#e53e3e;">${m.quantity_stock}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;">${m.quantity_min}</td>
    </tr>`
  ).join('');

  const content = `
    <h2>⚠️ Alerta de Stock Bajo</h2>
    <p>Los siguientes materiales tienen stock por debajo del mínimo:</p>
    <table style="width:100%;border-collapse:collapse;margin-top:16px;">
      <thead>
        <tr style="background:#f5f5f5;">
          <th style="padding:8px;text-align:left;">SKU</th>
          <th style="padding:8px;text-align:left;">Material</th>
          <th style="padding:8px;text-align:left;">Stock Actual</th>
          <th style="padding:8px;text-align:left;">Mínimo</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin-top:16px;">Por favor gestiona las órdenes de compra necesarias.</p>
  `;

  return sendEmail({
    to,
    subject: '⚠️ IncorERP - Alerta de Stock Bajo',
    html: emailTemplate(content, 'Alerta Stock Bajo'),
  });
};

/**
 * Send 2FA backup codes email
 */
const sendBackupCodesEmail = async ({ to, name, backupCodes }) => {
  const codesList = backupCodes.map((c) =>
    `<li style="font-family:monospace;font-size:16px;padding:4px 0;">${c}</li>`
  ).join('');

  const content = `
    <h2>Códigos de respaldo - Autenticación 2FA</h2>
    <p>Hola ${name},</p>
    <p>Has habilitado la autenticación de dos factores en tu cuenta. Aquí están tus <strong>códigos de respaldo</strong>:</p>
    <ul style="background:#f5f5f5;padding:16px 32px;border-radius:8px;">${codesList}</ul>
    <p><strong>⚠️ Importante:</strong></p>
    <ul>
      <li>Guarda estos códigos en un lugar seguro.</li>
      <li>Cada código solo puede usarse una vez.</li>
      <li>Úsalos si pierdes acceso a tu aplicación de autenticación.</li>
    </ul>
  `;

  return sendEmail({
    to,
    subject: 'IncorERP - Códigos de respaldo 2FA',
    html: emailTemplate(content, 'Códigos de respaldo 2FA'),
  });
};

module.exports = {
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendQuoteEmail,
  sendLowStockAlert,
  sendBackupCodesEmail,
};
