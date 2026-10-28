const express = require('express');
const db = require('../db');
const { authenticate, authorize, requireOrgContext, ROLE_GROUPS } = require('../middleware/auth');

const router = express.Router();

// Ask AI is available to management-level roles. Reception has no access to
// confidential clinical data, so it is excluded per the RBAC design.
const AI_ALLOWED_ROLES = ROLE_GROUPS.ADMIN.concat(['doctor']);

async function logQuery(orgId, user, question, answer) {
  (await db.prepare(`INSERT INTO ai_query_log (organization_id, user_id, role, question, answer) VALUES (?,?,?,?,?)`)
    .run(orgId, user.id, user.role, question, answer));
}

// ---------- Intent handlers ----------
// IMPORTANT: every single query below is filtered by organization_id. This module answers
// free-text questions (including ones that embed an arbitrary Patient ID typed by the
// user), and since patient_id values are unique platform-wide but NOT necessarily owned by
// the asking hospital, skipping the org filter here would let staff at Hospital B fetch
// Hospital A's patient data just by guessing/typing a PAT-000001-style ID in a question.
async function answerBedsAvailable(orgId, match) {
  const floorName = match && match[1] ? match[1].trim() : null;
  if (floorName) {
    const floor = (await db.prepare(`SELECT * FROM floors WHERE organization_id = ? AND (name LIKE ? OR floor_number = ?)`)
      .get(orgId, `%${floorName}%`, parseInt(floorName, 10) || -1));
    if (!floor) return `I couldn't find that information in the hospital records.`;
    const count = (await db.prepare(`
      SELECT COUNT(*) c FROM beds b JOIN rooms r ON r.id=b.room_id AND r.organization_id = b.organization_id
      WHERE b.organization_id = ? AND r.floor_id = ? AND b.status='Available'`).get(orgId, floor.id)).c;
    return `${floor.name} currently has ${count} available bed${count === 1 ? '' : 's'}.`;
  }
  const total = (await db.prepare(`SELECT COUNT(*) c FROM beds WHERE organization_id = ?`).get(orgId)).c;
  const avail = (await db.prepare(`SELECT COUNT(*) c FROM beds WHERE organization_id = ? AND status='Available'`).get(orgId)).c;
  return `There are currently ${avail} available beds out of ${total}.`;
}

async function answerBedsOccupied(orgId) {
  const total = (await db.prepare(`SELECT COUNT(*) c FROM beds WHERE organization_id = ?`).get(orgId)).c;
  const occ = (await db.prepare(`SELECT COUNT(*) c FROM beds WHERE organization_id = ? AND status='Occupied'`).get(orgId)).c;
  return `There are currently ${occ} occupied beds out of ${total}.`;
}

async function answerVacantBeds(orgId) {
  const rows = (await db.prepare(`
    SELECT b.bed_number, r.name as room_name FROM beds b
    JOIN rooms r ON r.id=b.room_id AND r.organization_id = b.organization_id
    WHERE b.organization_id = ? AND b.status='Available' ORDER BY b.bed_number`).all(orgId));
  if (rows.length === 0) return 'There are currently no available beds.';
  return `Available beds:\n` + rows.map(r => `${r.bed_number} \u2014 ${r.room_name}`).join('\n');
}

async function answerOccupiedBedsList(orgId) {
  const rows = (await db.prepare(`
    SELECT b.bed_number, r.name as room_name, f.name as floor_name FROM beds b
    JOIN rooms r ON r.id=b.room_id AND r.organization_id = b.organization_id
    JOIN floors f ON f.id=r.floor_id AND f.organization_id = b.organization_id
    WHERE b.organization_id = ? AND b.status='Occupied' ORDER BY f.floor_number, b.bed_number`).all(orgId));
  if (rows.length === 0) return 'There are currently no occupied beds.';
  return `Occupied beds:\n` + rows.map(r => `${r.bed_number} \u2014 ${r.room_name}, ${r.floor_name}`).join('\n');
}

async function answerOccupancy(orgId) {
  const total = (await db.prepare(`SELECT COUNT(*) c FROM beds WHERE organization_id = ?`).get(orgId)).c;
  const occ = (await db.prepare(`SELECT COUNT(*) c FROM beds WHERE organization_id = ? AND status='Occupied'`).get(orgId)).c;
  const pct = total ? Math.round((occ / total) * 100) : 0;
  return `${pct}% \u2014 ${occ} of ${total} beds are occupied.`;
}

async function answerAdmittedPatients(orgId) {
  const rows = (await db.prepare(`
    SELECT a.patient_id, p.full_name, b.bed_number, d.name as doctor_name
    FROM admissions a JOIN patients p ON p.patient_id=a.patient_id AND p.organization_id = a.organization_id
    LEFT JOIN beds b ON b.id=a.bed_id AND b.organization_id = a.organization_id
    LEFT JOIN doctors d ON d.id=a.attending_doctor_id AND d.organization_id = a.organization_id
    WHERE a.organization_id = ? AND a.status='Active' ORDER BY a.admitted_at DESC`).all(orgId));
  if (rows.length === 0) return 'No patients are currently admitted.';
  return `Currently admitted patients (${rows.length}):\n` +
    rows.map(r => `${r.patient_id} \u2014 ${r.full_name}, Bed ${r.bed_number || '-'}, Dr. ${r.doctor_name || '-'}`).join('\n');
}

async function answerPatientTreatment(orgId, pid) {
  const patient = (await db.prepare(`SELECT * FROM patients WHERE patient_id = ? AND organization_id = ?`).get(pid, orgId));
  if (!patient) return `I couldn't find that information in the hospital records.`;
  const admission = (await db.prepare(`
    SELECT a.*, d.name as doctor_name FROM admissions a
    LEFT JOIN doctors d ON d.id=a.attending_doctor_id AND d.organization_id = a.organization_id
    WHERE a.patient_id=? AND a.organization_id = ? AND a.status='Active'`).get(pid, orgId));
  if (!admission) return `${pid} (${patient.full_name}) is not currently admitted. No active treatment plan on record.`;
  return `${pid} is currently admitted under Dr. ${admission.doctor_name || '-'}. Diagnosis: ${admission.diagnosis || 'not recorded'}. Proposed treatment: ${admission.proposed_treatment || 'not recorded'}.`;
}

async function answerPatientHistory(orgId, pid) {
  const patient = (await db.prepare(`SELECT * FROM patients WHERE patient_id = ? AND organization_id = ?`).get(pid, orgId));
  if (!patient) return `I couldn't find that information in the hospital records.`;
  const visits = (await db.prepare(`SELECT COUNT(*) c FROM opd_visits WHERE patient_id=? AND organization_id = ?`).get(pid, orgId)).c;
  const admissions = (await db.prepare(`SELECT COUNT(*) c FROM admissions WHERE patient_id=? AND organization_id = ?`).get(pid, orgId)).c;
  const surgeries = (await db.prepare(`SELECT procedure_name, surgery_date FROM surgeries WHERE patient_id=? AND organization_id = ?`).all(pid, orgId));
  const discharges = (await db.prepare(`SELECT COUNT(*) c FROM discharge_summaries WHERE patient_id=? AND organization_id = ? AND status='Finalized'`).get(pid, orgId)).c;
  const lastDiagnosis = (await db.prepare(`SELECT diagnosis FROM consultations WHERE patient_id=? AND organization_id = ? ORDER BY created_at DESC LIMIT 1`).get(pid, orgId));
  let out = `${pid} \u2014 ${patient.full_name}, ${patient.age || '-'} yrs, ${patient.gender || '-'}\n`;
  out += `OPD visits: ${visits} | Admissions: ${admissions} | Completed discharges: ${discharges}\n`;
  if (lastDiagnosis) out += `Most recent diagnosis: ${lastDiagnosis.diagnosis || 'not recorded'}\n`;
  if (surgeries.length) out += `Surgeries: ${surgeries.map(s => `${s.procedure_name} (${s.surgery_date || '-'})`).join(', ')}`;
  return out;
}

async function answerPendingLab(orgId) {
  const rows = (await db.prepare(`
    SELECT l.patient_id, p.full_name, l.test_name, l.status
    FROM lab_orders l JOIN patients p ON p.patient_id=l.patient_id AND p.organization_id = l.organization_id
    JOIN admissions a ON a.patient_id=l.patient_id AND a.organization_id = l.organization_id AND a.status='Active'
    WHERE l.organization_id = ? AND l.status != 'Report Generated' ORDER BY l.ordered_at`).all(orgId));
  if (rows.length === 0) return 'No admitted patients currently have pending lab reports.';
  return `Pending lab reports:\n` + rows.map(r => `${r.full_name} (${r.patient_id}) \u2014 ${r.test_name} [${r.status}]`).join('\n');
}

async function answerSurgeriesThisMonth(orgId) {
  const monthPrefix = new Date().toISOString().slice(0, 7);
  const rows = (await db.prepare(`
    SELECT s.procedure_name, s.surgeon, s.surgery_date, p.full_name, p.patient_id
    FROM surgeries s JOIN patients p ON p.patient_id=s.patient_id AND p.organization_id = s.organization_id
    WHERE s.organization_id = ? AND s.surgery_date LIKE ? ORDER BY s.surgery_date`).all(orgId, `${monthPrefix}%`));
  if (rows.length === 0) return 'No surgeries have been recorded this month.';
  return `Surgeries this month:\n` + rows.map(r => `${r.full_name} (${r.patient_id}) \u2014 ${r.procedure_name}, Dr. ${r.surgeon || '-'}, ${r.surgery_date}`).join('\n');
}

async function answerDischargesThisMonth(orgId) {
  const monthPrefix = new Date().toISOString().slice(0, 7);
  const row = (await db.prepare(`SELECT COUNT(*) c FROM admissions WHERE organization_id = ? AND discharged_at LIKE ?`).get(orgId, `${monthPrefix}%`));
  return `${row.c} patient${row.c === 1 ? '' : 's'} discharged this month.`;
}

async function answerTodayOPD(orgId) {
  const today = new Date().toISOString().slice(0, 10);
  const total = (await db.prepare(`SELECT COUNT(*) c FROM opd_visits WHERE organization_id = ? AND visit_date=?`).get(orgId, today)).c;
  const waiting = (await db.prepare(`SELECT COUNT(*) c FROM opd_visits WHERE organization_id = ? AND visit_date=? AND status='Waiting'`).get(orgId, today)).c;
  return `Today's OPD: ${total} total registrations, ${waiting} currently waiting.`;
}

// ---------- Main NLU router (pattern matching over safe, parameterized, org-scoped queries) ----------
async function route(orgId, question) {
  const q = question.trim();
  const qLower = q.toLowerCase();
  const pidMatch = q.match(/PAT-\d{6}/i);

  if (/available.*floor|floor.*available/.test(qLower)) {
    const m = qLower.match(/floor\s*([a-z0-9 ]+)/);
    return (await answerBedsAvailable(orgId, m));
  }
  if (/how many beds? (are )?(available|free|vacant)/.test(qLower)) return (await answerBedsAvailable(orgId, null));
  if (/how many beds? (are )?occupied/.test(qLower)) return (await answerBedsOccupied(orgId));
  if (/which beds? (are )?(vacant|available|free)/.test(qLower)) return (await answerVacantBeds(orgId));
  if (/which beds? (are )?occupied/.test(qLower)) return (await answerOccupiedBedsList(orgId));
  if (/occupancy/.test(qLower)) return (await answerOccupancy(orgId));
  if (/which patients?.*(admitted|currently)/.test(qLower) || /admitted patients/.test(qLower)) return (await answerAdmittedPatients(orgId));
  if (pidMatch && /treatment|receiving/.test(qLower)) return (await answerPatientTreatment(orgId, pidMatch[0].toUpperCase()));
  if (pidMatch && /history|show me|timeline/.test(qLower)) return (await answerPatientHistory(orgId, pidMatch[0].toUpperCase()));
  if (pidMatch) return (await answerPatientHistory(orgId, pidMatch[0].toUpperCase()));
  if (/pending lab|lab.*pending/.test(qLower)) return (await answerPendingLab(orgId));
  if (/surgery|surgeries|procedure/.test(qLower)) return (await answerSurgeriesThisMonth(orgId));
  if (/discharge/.test(qLower) && /month/.test(qLower)) return (await answerDischargesThisMonth(orgId));
  if (/opd.*today|today.*opd/.test(qLower)) return (await answerTodayOPD(orgId));
  if (/total beds|how many beds/.test(qLower)) {
    const total = (await db.prepare(`SELECT COUNT(*) c FROM beds WHERE organization_id = ?`).get(orgId)).c;
    return `The hospital currently has ${total} beds configured.`;
  }

  return "I couldn't find that information in the hospital records. Try asking about bed availability, occupancy, admitted patients, a specific Patient ID (e.g. PAT-000001), pending lab reports, or recent surgeries.";
}

router.post('/ask', authenticate, requireOrgContext, authorize(AI_ALLOWED_ROLES), async (req, res) => {
  const { question } = req.body;
  if (!question || !question.trim()) return res.status(400).json({ error: 'Please enter a question.' });

  let answer;
  try {
    answer = (await route(req.orgId, question));
  } catch (e) {
    answer = "I couldn't find that information in the hospital records.";
  }

  (await logQuery(req.orgId, req.user, question, answer));
  res.json({ answer });
});

router.get('/history', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN), async (req, res) => {
  res.json((await db.prepare(`SELECT * FROM ai_query_log WHERE organization_id = ? ORDER BY created_at DESC LIMIT 100`).all(req.orgId)));
});

module.exports = router;
