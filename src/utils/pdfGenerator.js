'use strict';

const PDFDocument = require('pdfkit');
const { formatCurrency } = require('./helpers');

/**
 * Generate a PDF buffer for a quote
 * @param {object} quote - Full quote object with lines and client
 * @returns {Promise<Buffer>}
 */
const generateQuotePDF = (quote) => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
    const buffers = [];

    doc.on('data', (chunk) => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    const primaryColor = '#1a3a6b';
    const grayColor = '#666666';

    // Header
    doc.rect(0, 0, doc.page.width, 80).fill(primaryColor);
    doc.fillColor('#ffffff').fontSize(22).font('Helvetica-Bold')
      .text('INCORED Y ASOCIADOS', 50, 25);
    doc.fontSize(10).font('Helvetica')
      .text('Sistema ERP Empresarial', 50, 52);

    // Folio + Date
    doc.fillColor(primaryColor).fontSize(18).font('Helvetica-Bold')
      .text(`COTIZACIÓN`, doc.page.width - 200, 25, { align: 'right' });
    doc.fillColor(grayColor).fontSize(11).font('Helvetica')
      .text(`Folio: ${quote.folio}`, doc.page.width - 200, 50, { align: 'right' });

    doc.moveDown(3);

    // Client Info
    doc.fillColor(primaryColor).fontSize(12).font('Helvetica-Bold').text('DATOS DEL CLIENTE');
    doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).strokeColor(primaryColor).lineWidth(1).stroke();
    doc.moveDown(0.3);

    doc.fillColor('#333333').fontSize(10).font('Helvetica');
    doc.text(`Cliente: ${quote.client_name}`, { continued: false });
    doc.text(`RFC: ${quote.client_rfc || 'N/A'}`);
    doc.text(`Contacto: ${quote.client_contact || 'N/A'}`);
    doc.text(`Fecha de emisión: ${new Date(quote.issue_date).toLocaleDateString('es-MX')}`);
    doc.text(`Válida hasta: ${new Date(new Date(quote.issue_date).getTime() + quote.validity_days * 86400000).toLocaleDateString('es-MX')}`);

    doc.moveDown(1);

    // Table Header
    doc.fillColor(primaryColor).fontSize(12).font('Helvetica-Bold').text('CONCEPTO DE SERVICIOS / MATERIALES');
    doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).strokeColor(primaryColor).stroke();
    doc.moveDown(0.3);

    // Column headers
    const colX = { desc: 50, qty: 310, unit: 360, price: 410, disc: 460, total: 500 };
    doc.fillColor('#ffffff').rect(50, doc.y, doc.page.width - 100, 18).fill(primaryColor);
    doc.fillColor('#ffffff').fontSize(9).font('Helvetica-Bold');
    doc.text('Descripción', colX.desc + 2, doc.y - 16);
    doc.text('Cant.', colX.qty, doc.y - 16);
    doc.text('Unidad', colX.unit, doc.y - 16);
    doc.text('P. Unit.', colX.price, doc.y - 16);
    doc.text('Desc.%', colX.disc, doc.y - 16);
    doc.text('Total', colX.total, doc.y - 16);

    doc.moveDown(0.5);

    // Lines
    let isAlt = false;
    (quote.lines || []).forEach((line) => {
      const rowY = doc.y;
      if (isAlt) doc.rect(50, rowY - 2, doc.page.width - 100, 16).fill('#f9f9f9');
      doc.fillColor('#333333').fontSize(8).font('Helvetica');
      doc.text(line.description || '', colX.desc + 2, rowY, { width: 250 });
      doc.text(String(line.quantity), colX.qty, rowY);
      doc.text(line.unit || '', colX.unit, rowY);
      doc.text(formatCurrency(line.unit_price, quote.currency), colX.price, rowY);
      doc.text(`${line.discount_percent || 0}%`, colX.disc, rowY);
      doc.text(formatCurrency(line.line_total, quote.currency), colX.total, rowY);
      doc.moveDown(0.8);
      isAlt = !isAlt;
    });

    // Totals
    doc.moveDown(0.5);
    doc.moveTo(doc.page.width - 200, doc.y).lineTo(doc.page.width - 50, doc.y).strokeColor('#cccccc').stroke();
    doc.moveDown(0.3);

    const totY = doc.y;
    doc.fillColor(grayColor).fontSize(10).font('Helvetica');
    doc.text('Subtotal:', doc.page.width - 200, totY);
    doc.text(formatCurrency(quote.subtotal, quote.currency), doc.page.width - 100, totY, { align: 'right', width: 50 });

    doc.text(`IVA (${quote.tax_percent}%):`, doc.page.width - 200, doc.y);
    doc.text(formatCurrency(quote.subtotal * (quote.tax_percent / 100), quote.currency), doc.page.width - 100, doc.y - 12, { align: 'right', width: 50 });

    doc.moveDown(0.3);
    doc.rect(doc.page.width - 210, doc.y, 160, 22).fill(primaryColor);
    doc.fillColor('#ffffff').fontSize(12).font('Helvetica-Bold');
    doc.text('TOTAL:', doc.page.width - 205, doc.y - 18);
    doc.text(formatCurrency(quote.total, quote.currency), doc.page.width - 105, doc.y - 18, { align: 'right', width: 50 });

    // Terms
    if (quote.terms_conditions) {
      doc.moveDown(2);
      doc.fillColor(primaryColor).fontSize(10).font('Helvetica-Bold').text('TÉRMINOS Y CONDICIONES');
      doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).strokeColor(primaryColor).stroke();
      doc.moveDown(0.3);
      doc.fillColor('#333333').fontSize(9).font('Helvetica').text(quote.terms_conditions);
    }

    // Footer
    const footerY = doc.page.height - 50;
    doc.moveTo(50, footerY - 10).lineTo(doc.page.width - 50, footerY - 10).strokeColor('#cccccc').stroke();
    doc.fillColor(grayColor).fontSize(8).font('Helvetica')
      .text('Incored y Asociados | operaciones@incored.com.mx | www.incored.com.mx', 50, footerY, { align: 'center' });

    doc.end();
  });
};

/**
 * Generate a payroll PDF (comprobante de nómina)
 * @param {object} payroll - Payroll record with employee data
 * @returns {Promise<Buffer>}
 */
const generatePayrollPDF = (payroll) => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
    const buffers = [];
    doc.on('data', (chunk) => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    doc.fontSize(16).font('Helvetica-Bold').text('COMPROBANTE DE NÓMINA', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(10).font('Helvetica').text(`Empleado: ${payroll.employee_name}`);
    doc.text(`Período: ${payroll.period_start} - ${payroll.period_end}`);
    doc.text(`Empresa: ${payroll.company_name}`);
    doc.moveDown(1);
    doc.text(`Salario base: ${formatCurrency(payroll.base_salary)}`);
    doc.text(`Deducciones: ${formatCurrency(payroll.deductions)}`);
    doc.text(`Percepciones: ${formatCurrency(payroll.perceptions)}`);
    doc.fontSize(12).font('Helvetica-Bold').text(`Total neto: ${formatCurrency(payroll.net_pay)}`);
    doc.end();
  });
};

module.exports = { generateQuotePDF, generatePayrollPDF };
