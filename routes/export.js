'use strict';
// =============================================================================
// EDIMS — routes/export.js
// Streaming CSV and buffered PDF export endpoints
// Dependencies: csv-stringify, pdfkit
// =============================================================================

const express    = require('express');
const { stringify } = require('csv-stringify');
const PDFDocument   = require('pdfkit');

// Palette constants (matches SOC/NOC theme for PDF branding).
// Every color used anywhere in this file's PDF rendering lives here —
// no raw hex literals below this block. Some entries are intentionally
// distinct shades (e.g. the stat-box tints are darker variants chosen for
// contrast against white stat numbers, not the same as the badge colors
// used elsewhere in the app), kept as named, documented constants instead
// of magic strings repeated at each call site.
const COLOR = {
  bg:            '#0b0f19',  // page header bar background
  accent:        '#06b6d4',  // brand cyan (EDIMS wordmark)
  dark:          '#111827',
  muted:         '#94a3b8',  // secondary/caption text
  text:          '#1e293b',  // primary body text
  white:         '#ffffff',
  assigned:      '#10b981',
  faulty:        '#ef4444',
  ordered:       '#f59e0b',
  danger:        '#ef4444',
  tableHeaderBg: '#1e3a4a',  // table header row background
  tableHeaderFg: '#38bdf8',  // table header row text
  rowStripe:     '#f8fafc',  // even-row zebra striping
  statTotal:     '#0b0f19',  // stat-box tint: total/neutral
  statAssigned:  '#065f46',  // stat-box tint: assigned/verified (dark green)
  statInHand:    '#075985',  // stat-box tint: in-hand (dark blue)
  statFaulty:    '#7f1d1d',  // stat-box tint: faulty/discrepancy (dark red)
  statOrdered:   '#78350f',  // stat-box tint: ordered (dark amber)
  statUnverified:'#1e3a5f',  // stat-box tint: unverified (dark slate-blue)
};

// ─────────────────────────────────────────────────────────────────────────────
// Helper: flush a query result as a streaming CSV response
// ─────────────────────────────────────────────────────────────────────────────
function streamCsv(res, filename, rows, columns) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');

  const stringifier = stringify({
    header:     true,
    columns,
    cast: {
      date:    (v) => (v ? new Date(v).toISOString() : ''),
      boolean: (v) => (v ? 'Yes' : 'No'),
    },
  });

  stringifier.on('error', (err) => {
    console.error('[EXPORT] CSV stringifier error:', err.message);
    if (!res.headersSent) res.status(500).end('Export error');
  });

  stringifier.pipe(res);
  rows.forEach((r) => stringifier.write(r));
  stringifier.end();
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: PDFKit utility wrappers
// ─────────────────────────────────────────────────────────────────────────────
function pdfHeader(doc, title, subtitle) {
  // Title bar
  doc.rect(0, 0, doc.page.width, 64).fill(COLOR.bg);
  doc.fillColor(COLOR.accent).font('Helvetica-Bold').fontSize(18).text('EDIMS', 40, 18);
  doc.fillColor(COLOR.muted).font('Helvetica').fontSize(9)
     .text('Employee Device Inventory Management System', 40, 40);

  doc.fillColor(COLOR.white).font('Helvetica-Bold').fontSize(13)
     .text(title, 0, 20, { align: 'right', width: doc.page.width - 40 });
  doc.fillColor(COLOR.muted).font('Helvetica').fontSize(8)
     .text(subtitle || new Date().toUTCString(), 0, 38, { align: 'right', width: doc.page.width - 40 });

  doc.moveDown(4);
}

function pdfTableHeader(doc, columns) {
  const startX = doc.page.margins.left;
  const rowH   = 18;
  doc.rect(startX, doc.y, doc.page.width - startX - doc.page.margins.right, rowH)
     .fill(COLOR.tableHeaderBg);
  doc.fillColor(COLOR.tableHeaderFg).font('Helvetica-Bold').fontSize(7);
  let x = startX + 4;
  columns.forEach((col) => {
    doc.text(col.header.toUpperCase(), x, doc.y - rowH + 5, { width: col.width, lineBreak: false });
    x += col.width;
  });
  doc.moveDown(0.2);
}

function pdfTableRow(doc, columns, row, even) {
  const startX = doc.page.margins.left;
  const rowH   = 16;
  if (even) {
    doc.rect(startX, doc.y, doc.page.width - startX - doc.page.margins.right, rowH)
       .fill(COLOR.rowStripe);
  }
  doc.fillColor(COLOR.text).font('Helvetica').fontSize(7);
  let x = startX + 4;
  columns.forEach((col) => {
    const val = row[col.key] != null ? String(row[col.key]) : '—';
    doc.text(val, x, doc.y - rowH + 4, { width: col.width - 4, lineBreak: false });
    x += col.width;
  });
  doc.moveDown(0.15);
}

function pdfPageNumbers(doc) {
  const totalPages = doc.bufferedPageRange().count;
  for (let i = 0; i < totalPages; i++) {
    doc.switchToPage(i);
    doc.fillColor(COLOR.muted).font('Helvetica').fontSize(7)
       .text(
         `Page ${i + 1} of ${totalPages}  ·  EDIMS Confidential  ·  Generated ${new Date().toUTCString()}`,
         doc.page.margins.left,
         doc.page.height - 30,
         { align: 'center', width: doc.page.width - doc.page.margins.left - doc.page.margins.right }
       );
  }
}

// =============================================================================
// ROUTE FACTORY
// =============================================================================

module.exports = function exportRoutes(pool, can) {
  const router = express.Router();

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/export/assets.csv
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/assets.csv', can('assets:read'), async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT
             a.asset_tag, a.serial_number, a.qr_code, a.hardware_class,
             a.vendor, a.model, a.status, a.location,
             a.purchase_price, a.purchase_date, a.warranty_expiry,
             a.depreciation_years, a.notes,
             e.full_name     AS assigned_to,
             e.employee_code AS assigned_to_code,
             asgn.assigned_at,
             a.created_at,   a.updated_at
         FROM assets a
         LEFT JOIN assignments asgn ON asgn.asset_id = a.id AND asgn.returned_at IS NULL
         LEFT JOIN employees   e    ON e.id = asgn.employee_id
         ORDER BY a.hardware_class, a.asset_tag`
      );
      streamCsv(res, `edims-assets-${Date.now()}.csv`, rows, [
        { key: 'asset_tag',          header: 'Asset Tag' },
        { key: 'serial_number',      header: 'Serial Number' },
        { key: 'hardware_class',     header: 'Hardware Class' },
        { key: 'vendor',             header: 'Vendor' },
        { key: 'model',              header: 'Model' },
        { key: 'status',             header: 'Status' },
        { key: 'location',           header: 'Location' },
        { key: 'assigned_to',        header: 'Assigned To' },
        { key: 'assigned_to_code',   header: 'Employee Code' },
        { key: 'assigned_at',        header: 'Assigned Date' },
        { key: 'purchase_price',     header: 'Purchase Price' },
        { key: 'purchase_date',      header: 'Purchase Date' },
        { key: 'warranty_expiry',    header: 'Warranty Expiry' },
        { key: 'depreciation_years', header: 'Depreciation Years' },
        { key: 'qr_code',            header: 'QR Code' },
        { key: 'notes',              header: 'Notes' },
        { key: 'created_at',         header: 'Created At' },
        { key: 'updated_at',         header: 'Updated At' },
      ]);
    } catch (err) {
      console.error('[EXPORT] assets.csv error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Export failed.' });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/export/employees.csv
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/employees.csv', can('employees:read'), async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT
             e.employee_code, e.full_name, e.email, e.phone,
             e.department, e.designation, e.status,
             m.full_name AS reporting_manager,
             e.join_date, e.offboard_date, e.notes,
             COALESCE(agg.active_cnt, 0) AS active_assets,
             e.created_at
         FROM employees e
         LEFT JOIN employees m ON m.id = e.reporting_manager
         LEFT JOIN (
             SELECT employee_id, COUNT(*) AS active_cnt
             FROM assignments WHERE returned_at IS NULL GROUP BY employee_id
         ) agg ON agg.employee_id = e.id
         ORDER BY e.full_name`
      );
      streamCsv(res, `edims-employees-${Date.now()}.csv`, rows, [
        { key: 'employee_code',     header: 'Employee Code' },
        { key: 'full_name',         header: 'Full Name' },
        { key: 'email',             header: 'Email' },
        { key: 'phone',             header: 'Phone' },
        { key: 'department',        header: 'Department' },
        { key: 'designation',       header: 'Designation' },
        { key: 'reporting_manager', header: 'Reporting Manager' },
        { key: 'status',            header: 'Status' },
        { key: 'active_assets',     header: 'Active Assets' },
        { key: 'join_date',         header: 'Join Date' },
        { key: 'offboard_date',     header: 'Offboard Date' },
        { key: 'notes',             header: 'Notes' },
        { key: 'created_at',        header: 'Created At' },
      ]);
    } catch (err) {
      console.error('[EXPORT] employees.csv error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Export failed.' });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/export/assignments.csv
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/assignments.csv', can('assets:read'), async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT
             a.asset_tag, a.hardware_class, a.model, a.serial_number,
             e.employee_code, e.full_name, e.department, e.designation,
             asgn.assigned_at,
             asgn.returned_at,
             asgn.return_notes,
             u_a.username AS assigned_by,
             u_r.username AS returned_by
         FROM assignments asgn
         JOIN assets    a   ON a.id   = asgn.asset_id
         JOIN employees e   ON e.id   = asgn.employee_id
         JOIN users     u_a ON u_a.id = asgn.assigned_by
         LEFT JOIN users u_r ON u_r.id = asgn.returned_by
         ORDER BY asgn.assigned_at DESC`
      );
      streamCsv(res, `edims-assignments-${Date.now()}.csv`, rows, [
        { key: 'asset_tag',     header: 'Asset Tag' },
        { key: 'hardware_class',header: 'Class' },
        { key: 'model',         header: 'Model' },
        { key: 'serial_number', header: 'Serial' },
        { key: 'employee_code', header: 'Employee Code' },
        { key: 'full_name',     header: 'Employee Name' },
        { key: 'department',    header: 'Department' },
        { key: 'assigned_at',   header: 'Assigned At' },
        { key: 'returned_at',   header: 'Returned At' },
        { key: 'assigned_by',   header: 'Assigned By' },
        { key: 'returned_by',   header: 'Returned By' },
        { key: 'return_notes',  header: 'Return Notes' },
      ]);
    } catch (err) {
      console.error('[EXPORT] assignments.csv error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Export failed.' });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/export/history.csv
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/history.csv', can('assets:read'), async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT
             a.asset_tag, a.hardware_class,
             ah.event_type, ah.old_status, ah.new_status,
             e.full_name  AS employee,
             u.username   AS performed_by,
             ah.notes,
             ah.created_at
         FROM asset_history ah
         JOIN  assets    a ON a.id = ah.asset_id
         LEFT JOIN employees e ON e.id = ah.employee_id
         LEFT JOIN users     u ON u.id = ah.performed_by
         ORDER BY ah.created_at DESC`
      );
      streamCsv(res, `edims-history-${Date.now()}.csv`, rows, [
        { key: 'created_at',    header: 'Timestamp' },
        { key: 'asset_tag',     header: 'Asset Tag' },
        { key: 'hardware_class',header: 'Class' },
        { key: 'event_type',    header: 'Event' },
        { key: 'old_status',    header: 'From Status' },
        { key: 'new_status',    header: 'To Status' },
        { key: 'employee',      header: 'Employee' },
        { key: 'performed_by',  header: 'Operator' },
        { key: 'notes',         header: 'Notes' },
      ]);
    } catch (err) {
      console.error('[EXPORT] history.csv error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Export failed.' });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/export/assets.pdf
  // Full asset inventory report grouped by hardware class
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/assets.pdf', can('assets:read'), async (req, res) => {
    try {
      const [summaryRes, assetsRes] = await Promise.all([
        pool.query('SELECT * FROM dashboard_inventory_summary'),
        pool.query(
          `SELECT a.asset_tag, a.serial_number, a.hardware_class, a.vendor, a.model,
                  a.status, a.location, a.warranty_expiry,
                  e.full_name AS assigned_to, e.employee_code
           FROM assets a
           LEFT JOIN assignments asgn ON asgn.asset_id=a.id AND asgn.returned_at IS NULL
           LEFT JOIN employees   e    ON e.id=asgn.employee_id
           ORDER BY a.hardware_class, a.status, a.asset_tag`
        ),
      ]);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="edims-assets-${Date.now()}.pdf"`);
      res.setHeader('Cache-Control', 'no-store');

      const doc = new PDFDocument({
        size:         'A4',
        layout:       'landscape',
        bufferPages:  true,
        margins:      { top: 80, bottom: 40, left: 36, right: 36 },
      });
      doc.pipe(res);

      // ── Cover header ────────────────────────────────────────────────────
      pdfHeader(doc, 'Asset Inventory Report', `Generated ${new Date().toUTCString()}`);

      // ── KPI summary row ─────────────────────────────────────────────────
      const totals = summaryRes.rows.reduce(
        (acc, r) => {
          acc.total      += parseInt(r.total, 10);
          acc.assigned   += parseInt(r.assigned, 10);
          acc.in_hand    += parseInt(r.in_hand, 10);
          acc.faulty     += parseInt(r.faulty, 10);
          acc.ordered    += parseInt(r.ordered, 10);
          return acc;
        },
        { total: 0, assigned: 0, in_hand: 0, faulty: 0, ordered: 0 }
      );

      doc.fillColor(COLOR.text).font('Helvetica-Bold').fontSize(9).text('INVENTORY SUMMARY', { continued: false });
      doc.moveDown(0.4);

      const statY   = doc.y;
      const statGap = 110;
      const statX   = doc.page.margins.left;

      const stats = [
        { label: 'Total Assets',  value: totals.total,    color: COLOR.statTotal },
        { label: 'Assigned',      value: totals.assigned,  color: COLOR.statAssigned },
        { label: 'In-Hand',       value: totals.in_hand,   color: COLOR.statInHand },
        { label: 'Faulty',        value: totals.faulty,    color: COLOR.statFaulty },
        { label: 'Ordered',       value: totals.ordered,   color: COLOR.statOrdered },
      ];

      stats.forEach((s, i) => {
        doc.rect(statX + i * statGap, statY, 100, 42).fill(s.color);
        doc.fillColor(COLOR.white).font('Helvetica-Bold').fontSize(20)
           .text(String(s.value), statX + i * statGap + 6, statY + 4, { width: 88, lineBreak: false });
        doc.fillColor(COLOR.muted).font('Helvetica').fontSize(6)
           .text(s.label.toUpperCase(), statX + i * statGap + 6, statY + 28, { width: 88, lineBreak: false });
      });

      doc.y = statY + 52;
      doc.moveDown(1);

      // ── Per-class tables ─────────────────────────────────────────────────
      const classes = [...new Set(assetsRes.rows.map((r) => r.hardware_class))];
      const COLS = [
        { key: 'asset_tag',     header: 'Asset Tag',    width: 90  },
        { key: 'serial_number', header: 'Serial',       width: 120 },
        { key: 'model',         header: 'Model',        width: 130 },
        { key: 'vendor',        header: 'Vendor',       width: 80  },
        { key: 'status',        header: 'Status',       width: 80  },
        { key: 'location',      header: 'Location',     width: 90  },
        { key: 'assigned_to',   header: 'Assigned To',  width: 110 },
        { key: 'warranty_expiry',header:'Warranty',     width: 80  },
      ];

      for (const cls of classes) {
        const clsRows = assetsRes.rows.filter((r) => r.hardware_class === cls);

        // Add page if little space remains
        if (doc.y > doc.page.height - 120) doc.addPage();

        doc.fillColor(COLOR.bg).font('Helvetica-Bold').fontSize(9)
           .text(`${cls.toUpperCase()}  (${clsRows.length} assets)`, { underline: false });
        doc.moveDown(0.3);

        pdfTableHeader(doc, COLS);
        clsRows.forEach((row, i) => pdfTableRow(doc, COLS, row, i % 2 === 0));
        doc.moveDown(0.8);
      }

      pdfPageNumbers(doc);
      doc.end();
    } catch (err) {
      console.error('[EXPORT] assets.pdf error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'PDF export failed.' });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/export/audit-report.pdf
  // Query params: ?from=YYYY-MM-DD&to=YYYY-MM-DD&type=Monthly|Quarterly
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/audit-report.pdf', can('audits:read'), async (req, res) => {
    const { from, to, type } = req.query;

    const conds  = [];
    const params = [];
    if (from)  { params.push(from); conds.push(`al.audit_date >= $${params.length}::date`); }
    if (to)    { params.push(to);   conds.push(`al.audit_date <  ($${params.length}::date + INTERVAL '1 day')`); }
    if (type)  { params.push(type); conds.push(`al.audit_type = $${params.length}::audit_type`); }

    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    try {
      const { rows } = await pool.query(
        `SELECT al.audit_date, al.audit_type, al.verification_status,
                a.asset_tag, a.hardware_class,
                e.full_name   AS employee_name, e.employee_code,
                u.username    AS performed_by,
                al.notes, al.discrepancy_notes
         FROM audit_logs al
         LEFT JOIN assets    a ON a.id = al.asset_id
         LEFT JOIN employees e ON e.id = al.employee_id
         LEFT JOIN users     u ON u.id = al.performed_by
         ${where}
         ORDER BY al.audit_date DESC`,
        params
      );

      const verified    = rows.filter((r) => r.verification_status === 'Verified').length;
      const discrepancy = rows.filter((r) => r.verification_status === 'Discrepancy').length;
      const unverified  = rows.filter((r) => r.verification_status === 'Unverified').length;

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="edims-audit-${Date.now()}.pdf"`);
      res.setHeader('Cache-Control', 'no-store');

      const doc = new PDFDocument({
        size: 'A4', layout: 'landscape', bufferPages: true,
        margins: { top: 80, bottom: 40, left: 36, right: 36 },
      });
      doc.pipe(res);

      const subtitle = `${type || 'All'} audits${from ? ' from ' + from : ''}${to ? ' to ' + to : ''}  ·  ${rows.length} entries`;
      pdfHeader(doc, 'Audit Report', subtitle);

      // Summary stats
      const statY = doc.y;
      [
        { label: 'Total Entries', value: rows.length,   color: COLOR.statTotal },
        { label: 'Verified',      value: verified,      color: COLOR.statAssigned },
        { label: 'Discrepancy',   value: discrepancy,   color: COLOR.statFaulty },
        { label: 'Unverified',    value: unverified,    color: COLOR.statUnverified },
      ].forEach((s, i) => {
        doc.rect(doc.page.margins.left + i * 110, statY, 100, 42).fill(s.color);
        doc.fillColor(COLOR.white).font('Helvetica-Bold').fontSize(20)
           .text(String(s.value), doc.page.margins.left + i * 110 + 6, statY + 4,
             { width: 88, lineBreak: false });
        doc.fillColor(COLOR.muted).font('Helvetica').fontSize(6)
           .text(s.label.toUpperCase(), doc.page.margins.left + i * 110 + 6, statY + 28,
             { width: 88, lineBreak: false });
      });

      doc.y = statY + 54;
      doc.moveDown(0.8);

      const COLS = [
        { key: 'audit_date',        header: 'Date',         width: 100 },
        { key: 'audit_type',        header: 'Type',         width: 70  },
        { key: 'asset_tag',         header: 'Asset Tag',    width: 90  },
        { key: 'hardware_class',    header: 'Class',        width: 90  },
        { key: 'employee_code',     header: 'Emp Code',     width: 80  },
        { key: 'employee_name',     header: 'Employee',     width: 110 },
        { key: 'verification_status',header:'Status',       width: 80  },
        { key: 'performed_by',      header: 'Auditor',      width: 80  },
        { key: 'notes',             header: 'Notes',        width: 150 },
      ];

      pdfTableHeader(doc, COLS);
      rows.forEach((row, i) => {
        if (doc.y > doc.page.height - 60) { doc.addPage(); pdfTableHeader(doc, COLS); }
        // Format date nicely
        if (row.audit_date) row.audit_date = new Date(row.audit_date).toLocaleDateString('en-GB');
        pdfTableRow(doc, COLS, row, i % 2 === 0);
      });

      pdfPageNumbers(doc);
      doc.end();
    } catch (err) {
      console.error('[EXPORT] audit-report.pdf error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'PDF export failed.' });
    }
  });

  return router;
};
