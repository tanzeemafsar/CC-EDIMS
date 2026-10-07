'use strict';
// =============================================================================
// EDIMS — lib/approvals.js
// Approval workflow engine.
//
// A gated route validates its input, then calls
//     if (await approvals.needed(req, 'asset.create')) return approvals.submit(...)
// A non-Admin's action is stored as a Pending request instead of running.
// When an Admin approves it, the executor registered for that action runs
// with the stored (already validated) payload — re-validating against the
// current state — acting as the original requester. Admins' own actions are
// never gated: they are the approvers.
//
// Executors: async (payload, ctx) => ({ status, body })
//   ctx = { userId, role, approvedBy, approvedByName, requestNo }
//   status < 300 is success; anything else marks the request Failed with
//   body.error as the reason.
// =============================================================================

const ACTIONS = {
  'procurement.order':  'Purchase / order request',
  'asset.create':       'Register new device',
  'assignment.create':  'Assign device',
  'assignment.return':  'Return device',
  'asset.retire':       'Retire device',
  'asset.mark_ordered': 'Mark device as ordered',
  'asset.mark_faulty':  'Mark device faulty',
  'asset.repair':       'Mark device repaired',
  'invoice.issue':      'Issue invoice',
};

function makeApprovals({ query, withTransaction }) {
  const executors = {};

  function register(action, fn) {
    if (!ACTIONS[action]) throw new Error(`Unknown approval action ${action}`);
    executors[action] = fn;
  }

  // Does this request need approval? Admins never do; unknown policy rows
  // default to "required" so a new action is safe until configured.
  async function needed(req, action) {
    if (req.session.role === 'Admin') return false;
    const { rows: [p] } = await query('SELECT requires_approval FROM approval_policies WHERE action=$1', [action]);
    return p ? p.requires_approval : true;
  }

  // Store the request and answer 202 Accepted with it.
  async function submit(req, res, action, payload, summary, { details = {}, assetId = null, justification } = {}) {
    const just = justification === undefined ? req.body && req.body.justification : justification;
    const cleanJust = just == null ? null : String(just).trim().slice(0, 1000) || null;
    const { rows: [r] } = await query(
      `INSERT INTO approval_requests (action, summary, payload, details, justification, asset_id, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, request_no, action, status, summary, requested_at`,
      [action, summary, payload, details, cleanJust, assetId, req.session.userId]
    );
    return res.status(202).json({
      pending_approval: true,
      approval: { ...r, action_label: ACTIONS[action] },
      message: `Sent for Admin approval as REQ-${r.request_no}.`,
    });
  }

  // Approve: claim the row atomically (so two Admins can't run it twice),
  // run the executor as the requester, record the outcome.
  async function approve(id, admin, note) {
    const { rows: [r] } = await query(
      `UPDATE approval_requests SET status='Approved', decided_by=$2, decided_at=NOW(), decision_note=$3
       WHERE id=$1 AND status='Pending'
       RETURNING approval_requests.*,
                 (SELECT r.name FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=approval_requests.requested_by) AS requester_role`,
      [id, admin.userId, note || null]
    );
    if (!r) return { status: 409, error: 'Request is not pending (already decided or cancelled).' };
    const exec = executors[r.action];
    let out;
    try {
      if (!exec) throw new Error(`No executor registered for ${r.action}`);
      out = await exec(r.payload, {
        userId: r.requested_by, role: r.requester_role,
        approvedBy: admin.userId, approvedByName: admin.username, requestNo: r.request_no, requestId: r.id,
      });
    } catch (err) {
      console.error('[APPROVALS] Executor error:', r.action, err.message);
      out = { status: 500, body: { error: 'The approved action failed to run: ' + err.message } };
    }
    if (out.status >= 300) {
      await query(`UPDATE approval_requests SET status='Failed', error=$2, result=$3 WHERE id=$1`,
        [id, (out.body && out.body.error) || 'Action failed.', out.body || null]);
      return { status: 200, failed: true, error: (out.body && out.body.error) || 'Action failed.' };
    }
    await query(`UPDATE approval_requests SET result=$2 WHERE id=$1`, [id, out.body || null]);
    return { status: 200, result: out.body };
  }

  async function reject(id, admin, note) {
    const { rowCount } = await query(
      `UPDATE approval_requests SET status='Rejected', decided_by=$2, decided_at=NOW(), decision_note=$3
       WHERE id=$1 AND status='Pending'`, [id, admin.userId, note || null]);
    return rowCount ? { status: 200 } : { status: 409, error: 'Request is not pending.' };
  }

  async function cancel(id, user) {
    const { rowCount } = await query(
      `UPDATE approval_requests SET status='Cancelled', decided_by=$2, decided_at=NOW(), decision_note='Cancelled by requester'
       WHERE id=$1 AND status='Pending' AND requested_by=$2`, [id, user.userId]);
    return rowCount ? { status: 200 } : { status: 409, error: 'Only your own pending requests can be cancelled.' };
  }

  // " (approved by admin, REQ-12)" for history notes
  function approvalNote(ctx) {
    return ctx && ctx.approvedByName ? ` (approved by ${ctx.approvedByName}, REQ-${ctx.requestNo})` : '';
  }

  return { ACTIONS, register, needed, submit, approve, reject, cancel, approvalNote, withTransaction };
}

module.exports = { makeApprovals, ACTIONS };
