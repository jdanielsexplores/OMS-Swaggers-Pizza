// Approval workflow. Each approval may carry a payload that is applied automatically when approved.
const db = require('../db');
const { notify } = require('./notify');
const { sqlNow, money, addDays } = require('../lib/util');

const LEVEL = { ops_manager: ['ops_manager', 'owner'], owner: ['owner'] };

function request({ kind, title, details, amount, entity, entity_id, payload, required_role }, user) {
  const id = db.insert('approvals', {
    kind, title, details, amount, entity, entity_id,
    payload: payload ? JSON.stringify(payload) : null,
    required_role: required_role || 'ops_manager',
    requested_by: user?.id,
  });
  notify({ roles: LEVEL[required_role || 'ops_manager'], except: user?.id }, {
    level: 'warning',
    title: `Approval needed: ${title}`,
    body: amount ? money(amount) : details?.slice(0, 120),
    link: `/approvals/${id}`,
  });
  return id;
}

const canDecide = (user, approval) => (LEVEL[approval.required_role] || ['owner']).includes(user.role) && approval.requested_by !== user.id || user.role === 'owner';

// Side effects applied when an approval is decided.
const handlers = {
  expense(a, approved) {
    if (a.entity_id) db.update('transactions', a.entity_id, { status: approved ? 'approved' : 'rejected' });
  },
  refund(a, approved, user) {
    if (!a.entity_id) return;
    db.update('refunds', a.entity_id, { status: approved ? 'approved' : 'rejected', approved_by: user.id, approved_at: sqlNow() });
    if (approved) notify({ roles: ['accounts'] }, { level: 'info', title: 'Refund approved — ready to pay', body: a.title, link: '/customers/refunds' });
  },
  price_change(a, approved) {
    if (!approved || !a.payload) return;
    const p = JSON.parse(a.payload);
    db.update('products', p.product_id, { price: p.new_price });
  },
  menu_change(a, approved) {
    if (!approved || !a.payload) return;
    const p = JSON.parse(a.payload);
    db.update('products', p.product_id, { approved: 1, available: p.available ?? 1 });
  },
  sop_change(a, approved, user) {
    if (!a.entity_id) return;
    const sop = db.get('SELECT * FROM sops WHERE id = ?', a.entity_id);
    if (!approved) { db.update('sops', sop.id, { draft: null }); return; }
    const patch = { status: 'approved', approved_by: user.id, approved_at: sqlNow(), draft: null, updated_at: sqlNow() };
    if (sop.draft) {
      Object.assign(patch, JSON.parse(sop.draft));
      const [maj, min] = String(sop.version || '1.0').split('.').map(Number);
      patch.version = sop.status === 'draft' ? '1.0' : `${maj}.${(min || 0) + 1}`;
    }
    db.update('sops', sop.id, patch);
    notify({ roles: ['owner', 'ops_manager', 'accounts', 'supervisor', 'technician', 'stock_staff', 'sales_rep'], except: user.id }, { title: `Procedure updated: ${sop.code} ${patch.title || sop.title}`, body: 'Please read the new version.', link: `/handbook/${sop.code}` });
  },
  leave(a, approved, user) {
    if (!a.entity_id) return;
    db.update('leave_requests', a.entity_id, { status: approved ? 'approved' : 'rejected', decided_by: user.id, decided_at: sqlNow() });
    const l = db.get('SELECT * FROM leave_requests WHERE id = ?', a.entity_id);
    // PRD: approving a late permission recalculates the affected attendance automatically.
    if (approved) {
      const att = require('./attendance');
      for (let d = l.start_date; d <= l.end_date; d = addDays(d, 1)) att.recalcUserDate(l.user_id, d);
    }
    notify({ users: [l.user_id] }, { level: approved ? 'success' : 'warning', title: `${l.leave_type === 'late_permission' ? 'Late permission' : 'Leave'} ${approved ? 'approved' : 'rejected'}`, body: `${l.start_date}${l.end_date !== l.start_date ? ' → ' + l.end_date : ''}${l.until_time ? ' (arrive by ' + l.until_time + ')' : ''}`, link: '/leave', email: true });
  },
};

function decide(id, approved, user, notes) {
  const a = db.get('SELECT * FROM approvals WHERE id = ?', id);
  if (!a || a.status !== 'pending') throw new Error('This approval is no longer pending');
  if (!canDecide(user, a)) throw new Error('You are not allowed to decide this approval');
  db.tx(() => {
    db.update('approvals', id, { status: approved ? 'approved' : 'rejected', decided_by: user.id, decided_at: sqlNow(), decision_notes: notes || null });
    handlers[a.kind]?.(a, approved, user);
  });
  if (a.requested_by) {
    notify({ users: [a.requested_by] }, { level: approved ? 'success' : 'warning', title: `${approved ? 'Approved' : 'Rejected'}: ${a.title}`, body: notes || '', link: `/approvals/${id}` });
  }
}

module.exports = { request, decide, canDecide };
