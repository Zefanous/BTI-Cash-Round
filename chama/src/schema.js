'use strict';
// Each table maps 1:1 to a worksheet tab (Google Sheets) or a CSV file (local mode).
// Column types: s=string, n=number, j=json (stored as text).
const TABLES = {
  Members: { cols: { id: 'n', member_code: 's', name: 's', phone: 's', email: 's', role: 's', participates: 'n', status: 's', join_date: 's', password_hash: 's', created_at: 's' },
    unique: [['member_code']] },
  Config: { cols: { id: 'n', key: 's', value: 's' }, unique: [['key']] },
  Cycles: { cols: { id: 'n', cycle_number: 'n', start_month: 's', end_month: 's', status: 's', group_size: 'n', amount: 'n', current_month: 'n', draw_hash: 's', draw_salt: 's', created_by: 'n', created_at: 's', locked_at: 's', closed_at: 's' },
    unique: [['cycle_number']] },
  DrawResults: { cols: { id: 'n', cycle_id: 'n', member_id: 'n', position: 'n', original_position: 'n', drawn_at: 's', proof_hash: 's' },
    unique: [['cycle_id', 'position'], ['cycle_id', 'member_id']] },
  Contributions: { cols: { id: 'n', cycle_id: 'n', member_id: 'n', month_no: 'n', amount: 'n', penalty: 'n', method: 's', status: 's', paid_at: 's', recorded_by: 'n', client_ref: 's', created_at: 's' },
    unique: [['cycle_id', 'member_id', 'month_no']] },
  Payouts: { cols: { id: 'n', cycle_id: 'n', member_id: 'n', month_no: 'n', position: 'n', amount: 'n', method: 's', paid_at: 's', receipt_no: 's', recorded_by: 'n', status: 's', note: 's' },
    unique: [['cycle_id', 'month_no'], ['cycle_id', 'position'], ['receipt_no']] },
  Notifications: { cols: { id: 'n', member_id: 'n', type: 's', channel: 's', message: 's', sent_at: 's', status: 's' }, unique: [] },
  Announcements: { cols: { id: 'n', title: 's', body: 's', kind: 's', created_by: 'n', created_at: 's' }, unique: [] },
  AuditLogs: { cols: { id: 'n', actor_id: 'n', action: 's', entity: 's', entity_id: 'n', summary: 's', before: 'j', after: 'j', timestamp: 's', prev_hash: 's', hash: 's' }, unique: [] },
  IdempotencyKeys: { cols: { id: 'n', key: 's', result_id: 'n', created_at: 's' }, unique: [['key']] },
};
module.exports = { TABLES };
