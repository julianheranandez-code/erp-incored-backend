'use strict';

const XLSX = require('xlsx');

/**
 * Generic Excel export helper
 * @param {object[]} data - Array of row objects
 * @param {string} sheetName - Worksheet name
 * @param {object[]} [columns] - Column definitions: { header, key, width }
 * @returns {Buffer} Excel file buffer
 */
const exportToExcel = (data, sheetName = 'Datos', columns = null) => {
  const wb = XLSX.utils.book_new();

  let rows = data;

  // If column definitions provided, remap keys to headers
  if (columns) {
    rows = data.map((row) => {
      const mapped = {};
      columns.forEach((col) => {
        mapped[col.header] = row[col.key] !== undefined ? row[col.key] : '';
      });
      return mapped;
    });
  }

  const ws = XLSX.utils.json_to_sheet(rows);

  // Set column widths
  if (columns) {
    ws['!cols'] = columns.map((col) => ({ wch: col.width || 15 }));
  }

  XLSX.utils.book_append_sheet(wb, ws, sheetName.substring(0, 31)); // Excel limit: 31 chars

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};

/**
 * Export projects report
 * @param {object[]} projects
 * @returns {Buffer}
 */
const exportProjectsReport = (projects) => {
  return exportToExcel(projects, 'Proyectos', [
    { header: 'Código', key: 'code', width: 15 },
    { header: 'Nombre', key: 'name', width: 35 },
    { header: 'Cliente', key: 'client_name', width: 30 },
    { header: 'Empresa', key: 'company_name', width: 25 },
    { header: 'PM', key: 'pm_name', width: 25 },
    { header: 'Estado', key: 'status', width: 15 },
    { header: 'Avance %', key: 'progress_percent', width: 12 },
    { header: 'Presupuesto', key: 'budget_amount', width: 15 },
    { header: 'Moneda', key: 'currency', width: 10 },
    { header: 'Margen Esperado %', key: 'expected_margin', width: 18 },
    { header: 'Fecha Inicio', key: 'start_date', width: 15 },
    { header: 'Fecha Fin Planeada', key: 'end_date_planned', width: 20 },
    { header: 'Fecha Fin Real', key: 'end_date_real', width: 18 },
    { header: 'País', key: 'country', width: 15 },
    { header: 'Ciudad', key: 'city', width: 15 },
  ]);
};

/**
 * Export transactions report
 * @param {object[]} transactions
 * @returns {Buffer}
 */
const exportTransactionsReport = (transactions) => {
  return exportToExcel(transactions, 'Transacciones', [
    { header: 'ID', key: 'id', width: 8 },
    { header: 'Tipo', key: 'type', width: 15 },
    { header: 'Categoría', key: 'category', width: 20 },
    { header: 'Empresa', key: 'company_name', width: 25 },
    { header: 'Proyecto', key: 'project_name', width: 30 },
    { header: 'Cliente/Proveedor', key: 'client_name', width: 25 },
    { header: 'Monto', key: 'amount', width: 15 },
    { header: 'Moneda', key: 'currency', width: 10 },
    { header: 'Descripción', key: 'description', width: 40 },
    { header: 'Referencia', key: 'reference_number', width: 20 },
    { header: 'Fecha', key: 'transaction_date', width: 15 },
    { header: 'Estado', key: 'status', width: 15 },
    { header: 'Registrado por', key: 'created_by_name', width: 25 },
  ]);
};

/**
 * Export inventory report
 * @param {object[]} materials
 * @returns {Buffer}
 */
const exportInventoryReport = (materials) => {
  return exportToExcel(materials, 'Inventario', [
    { header: 'SKU', key: 'sku', width: 15 },
    { header: 'Nombre', key: 'name', width: 35 },
    { header: 'Categoría', key: 'category', width: 20 },
    { header: 'Stock Actual', key: 'quantity_stock', width: 15 },
    { header: 'Stock Mínimo', key: 'quantity_min', width: 15 },
    { header: 'Stock Máximo', key: 'quantity_max', width: 15 },
    { header: 'Unidad', key: 'unit_of_measure', width: 12 },
    { header: 'Costo Último', key: 'cost_last_purchase', width: 15 },
    { header: 'Costo Promedio', key: 'cost_average', width: 15 },
    { header: 'Valuación', key: 'valuation', width: 15 },
    { header: 'Empresa', key: 'company_name', width: 20 },
    { header: 'Proveedor', key: 'supplier_name', width: 25 },
    { header: 'Último Movimiento', key: 'last_movement_date', width: 20 },
  ]);
};

/**
 * Export timesheet report
 * @param {object[]} entries
 * @returns {Buffer}
 */
const exportTimesheetReport = (entries) => {
  return exportToExcel(entries, 'Timesheet', [
    { header: 'Usuario', key: 'user_name', width: 25 },
    { header: 'Proyecto', key: 'project_name', width: 30 },
    { header: 'Tarea', key: 'task_title', width: 35 },
    { header: 'Inicio', key: 'start_time', width: 20 },
    { header: 'Fin', key: 'end_time', width: 20 },
    { header: 'Duración (min)', key: 'duration_minutes', width: 15 },
    { header: 'Notas', key: 'notes', width: 40 },
  ]);
};

module.exports = {
  exportToExcel,
  exportProjectsReport,
  exportTransactionsReport,
  exportInventoryReport,
  exportTimesheetReport,
};
