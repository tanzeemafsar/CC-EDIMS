'use strict';
// =============================================================================
// EDIMS — routes/approvals.js
// Admin approval queue and rules.
//   GET  /api/approvals?status=&limit=      Admin: everyone's; others: their own
//   GET  /api/approvals/summary             counts for the notification bell
//   POST /api/approvals/:id/approve         { note? }   (Admin) — runs the action
//   POST /api/approvals/:id/reject          { note }    (Admin)
//   POST /api/approvals/:id/cancel                       (the requester)
//   GET  /api/approvals/policies            which actions need approval
//   PUT  /api/approvals/policies/:action    { requires_approval } (Admin)
// =============================================================================

const express = require('express');
const { sanitizeStr, isUUID } = require('../lib/helpers');

const STATUSES = ['Pending', 'Approved', 'Rejected', 'Cancelled', 'Failed'];

module.exports = function approvalRoutes({ query }, can, approvals) {
  const router = express.Router();
  const label = (a) => approvals.ACTIONS[a] || a;

  router.get('/summary', can('approvals:read'), async (req, res) => {
    try {
      const isAdmin = req.session.role === 'Admin';
      const { rows: [c] } = await query(
        `SELECT
           COUNT(*) FILTER (WHERE status='Pending' ${isAdmin ? '' : 'AND requested_by=$1'})::int AS pending,
           COUNT(*) FILTER (WHERE requested_by=$1 AND status IN ('Approved','Rejected','Failed')
                              AND decided_at > NOW() - INTERVAL '7 days')::int AS my_recent_decisions
         FROM approval_requests`, [req.session.userId]);
      return res.json(c);
    } catch (err) {
      console.error('[APPROVALS] summary error:', err.message);
      return res.status(500).json({ error: 'Failed to load approval summary.' });
    }
  });

  router.get('/', can('approvals:read'), async (req, res) => {
    const conds = [], params = [];
    if (req.session.role !== 'Admin') {
      params.push(req.session.userId); conds.push(`ar.requested_by=$${params.length}`);
    }
    if (req.query.status) {
      if (!STATUSES.includes(req.query.status)) return res.status(400).json({ error: 'Invalid status.' });
      params.push(req.query.status); conds.push(`ar.status=$${params.length}`);
    }
    params.push(Math.min(parseInt(req.query.limit, 10) || 200, 500));
    try {
      const { rows } = await query(
        `SELECT ar.id, ar.request_no, ar.action, ar.status, ar.summary, ar.details, ar.justification,
                ar.requested_at, ar.decided_at, ar.decision_note, ar.error, ar.result,
                ur.username AS requested_by_username, ud.username AS decided_by_username
         FROM approval_requests ar
         JOIN users ur ON ur.id = ar.requested_by
         LEFT JOIN users ud ON ud.id = ar.decided_by
         ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
         ORDER BY (ar.status = 'Pending') DESC, ar.requested_at DESC
         LIMIT $${params.length}`, params);
      rows.forEach(r => { r.action_label = label(r.action); });
      return res.json({ requests: rows });
    } catch (err) {
      console.error('[APPROVALS] list error:', err.message);
      return res.status(500).json({ error: 'Failed to load approval requests.' });
    }
  });

  function decide(kind) {
    return async (req, res) => {
      const { id } = req.params;
      if (!isUUID(id)) return res.status(400).json({ error: 'Invalid request ID.' });
      const note = sanitizeStr(req.body && req.body.note);
      if (note && note.length > 1000) return res.status(400).json({ error: 'note is limited to 1000 characters.' });
      if (kind === 'reject' && !note) return res.status(400).json({ error: 'Give a reason when rejecting a request.' });
      const who = { userId: req.session.userId, username: req.session.username };
      try {
        const out = kind === 'approve' ? await approvals.approve(id, who, note)
                  : kind === 'reject'  ? await approvals.reject(id, who, note)
                  : await approvals.cancel(id, who);
        if (out.status >= 300) return res.status(out.status).json({ error: out.error });
        const { rows: [r] } = await query(
          'SELECT id, request_no, action, status, summary, error, result FROM approval_requests WHERE id=$1', [id]);
        return res.json({ request: { ...r, action_label: label(r.action) } });
      } catch (err) {
        console.error(`[APPROVALS] ${kind} error:`, err.message);
        return res.status(500).json({ error: `Failed to ${kind} the request.` });
      }
    };
  }
  router.post('/:id/approve', can('approvals:decide'), decide('approve'));
  router.post('/:id/reject',  can('approvals:decide'), decide('reject'));
  router.post('/:id/cancel',  can('approvals:read'),   decide('cancel'));

  router.get('/policies', can('approvals:read'), async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT p.action, p.requires_approval, p.updated_at, u.username AS updated_by_username
         FROM approval_policies p LEFT JOIN users u ON u.id = p.updated_by`, []);
      const byAction = new Map(rows.map(r => [r.action, r]));
      // Every known action, in a stable order; missing rows default to "required"
      const policies = Object.keys(approvals.ACTIONS).map(a => ({
        action: a, label: label(a),
        requires_approval: byAction.has(a) ? byAction.get(a).requires_approval : true,
        updated_at: byAction.has(a) ? byAction.get(a).updated_at : null,
        updated_by_username: byAction.has(a) ? byAction.get(a).updated_by_username : null,
      }));
      return res.json({ policies });
    } catch (err) {
      console.error('[APPROVALS] policies error:', err.message);
      return res.status(500).json({ error: 'Failed to load approval rules.' });
    }
  });

  router.put('/policies/:action', can('approvals:decide'), async (req, res) => {
    const { action } = req.params;
    if (!approvals.ACTIONS[action]) return res.status(404).json({ error: 'Unknown action.' });
    const v = req.body && req.body.requires_approval;
    if (typeof v !== 'boolean') return res.status(400).json({ error: 'requires_approval must be true or false.' });
    try {
      await query(
        `INSERT INTO approval_policies (action, requires_approval, updated_by, updated_at) VALUES ($1,$2,$3,NOW())
         ON CONFLICT (action) DO UPDATE SET requires_approval=EXCLUDED.requires_approval,
                                           updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
        [action, v, req.session.userId]);
      return res.json({ action, requires_approval: v });
    } catch (err) {
      console.error('[APPROVALS] policy update error:', err.message);
      return res.status(500).json({ error: 'Failed to update the approval rule.' });
    }
  });

  return router;
};
