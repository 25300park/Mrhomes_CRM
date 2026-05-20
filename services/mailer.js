const nodemailer = require('nodemailer')

// Gmail 트랜스포터 (앱 비밀번호 사용)
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS   // Gmail 앱 비밀번호
  }
})

const PHP = n => '₱' + Math.round(n || 0).toLocaleString('en-PH')

const STATUS_KO = {
  NEW: '신규', SEARCHING: '매물탐색', OFFER_SENT: '제안완료',
  NEGOTIATING: '협상중', CLOSED_WON: '계약성사', CLOSED_LOST: '미성사'
}

const TYPE_KO = {
  OWNER: '임대인', TENANT: '임차인', BUYER: '매수인',
  SELLER: '매도인', 'CO-BROKER': 'Co-Broker'
}

// ── 팔로업 리마인더 이메일 ─────────────────────────────
async function sendFollowupReminder(agent, leads) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.log(`[Mailer] 이메일 설정 없음 — ${agent.name}의 팔로업 ${leads.length}건 (이메일 발송 건너뜀)`)
    return
  }
  if (!leads.length) return

  const today = new Date().toLocaleDateString('ko-KR', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
  })
  const appUrl = process.env.APP_URL || 'http://localhost:4000'

  const html = `
<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<style>
  body { font-family: -apple-system, sans-serif; margin: 0; background: #F4F1EC; }
  .wrap { max-width: 560px; margin: 0 auto; }
  .header { background: #1C3553; color: #fff; padding: 24px 28px; }
  .header h2 { margin: 0 0 4px; font-size: 18px; }
  .header p  { margin: 0; font-size: 13px; opacity: .6; }
  .body { background: #fff; padding: 24px 28px; }
  .greeting { font-size: 15px; color: #1C3553; margin-bottom: 16px; }
  .count-box { background: #FDEAEA; border-left: 4px solid #DC4A4A; border-radius: 8px; padding: 12px 16px; margin-bottom: 20px; font-size: 14px; color: #A32D2D; font-weight: 600; }
  .item { border: 1px solid #EAE6DF; border-radius: 10px; padding: 14px 16px; margin-bottom: 10px; }
  .item-name { font-size: 15px; font-weight: 700; color: #1C3553; margin-bottom: 6px; }
  .item-row { font-size: 12px; color: #6B7280; margin-bottom: 3px; }
  .item-row strong { color: #1C3553; }
  .status-badge { display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 20px; background: #FDF0DC; color: #854F0B; margin-left: 6px; }
  .remarks { font-size: 12px; color: #1C3553; background: #F8F5F0; border-radius: 6px; padding: 8px 10px; margin-top: 8px; line-height: 1.5; }
  .overdue { border-color: #DC4A4A; }
  .overdue .item-name { color: #DC4A4A; }
  .cta { text-align: center; padding: 24px 0; }
  .cta a { background: #1C3553; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-size: 14px; font-weight: 600; }
  .footer { background: #F8F5F0; padding: 16px 28px; font-size: 11px; color: #6B7280; text-align: center; }
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <h2>🏠 RBS Homes CRM</h2>
    <p>팔로업 리마인더 · ${today}</p>
  </div>
  <div class="body">
    <div class="greeting">안녕하세요, <strong>${agent.name}</strong>님</div>
    <div class="count-box">
      📋 오늘 팔로업이 필요한 고객이 <strong>${leads.length}명</strong> 있습니다.
    </div>
    ${leads.map((l, i) => {
      const today_str = new Date().toISOString().split('T')[0]
      const isOverdue = l.next_followup_at < today_str
      return `
    <div class="item${isOverdue ? ' overdue' : ''}">
      <div class="item-name">
        ${i + 1}. ${l.contact_name || '-'}
        ${isOverdue ? '<span style="font-size:11px;background:#FDEAEA;color:#DC4A4A;padding:2px 7px;border-radius:20px;margin-left:6px">지연</span>' : ''}
        <span class="status-badge">${STATUS_KO[l.status] || l.status}</span>
      </div>
      <div class="item-row">📱 <strong>${l.contact_mobile || '-'}</strong></div>
      ${l.budget ? `<div class="item-row">💰 예산: <strong>${PHP(l.budget)}${l.request_type === 'RENT' ? '/월' : ''}</strong></div>` : ''}
      ${l.location_pref ? `<div class="item-row">📍 지역: <strong>${l.location_pref}</strong></div>` : ''}
      <div class="item-row">📅 팔로업 예정: <strong>${l.next_followup_at}</strong></div>
      ${l.remarks ? `<div class="remarks">${l.remarks}</div>` : ''}
    </div>`
    }).join('')}
    <div class="cta">
      <a href="${appUrl}">CRM에서 확인하기 →</a>
    </div>
  </div>
  <div class="footer">
    RBS Homes CRM · 이 메일은 자동 발송됩니다
  </div>
</div>
</body>
</html>`

  await transporter.sendMail({
    from: `"RBS Homes CRM" <${process.env.EMAIL_USER}>`,
    to:   agent.email,
    subject: `[RBS Homes] 오늘 팔로업 ${leads.length}건 · ${new Date().toLocaleDateString('ko-KR')}`,
    html
  })

  console.log(`[Mailer] ✓ ${agent.name} <${agent.email}> — 팔로업 ${leads.length}건 발송`)
}

// ── 연결 테스트 ─────────────────────────────────────────
async function testConnection() {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) return false
  try {
    await transporter.verify()
    console.log('[Mailer] ✓ Gmail 연결 성공')
    return true
  } catch(e) {
    console.warn('[Mailer] ✗ Gmail 연결 실패:', e.message)
    return false
  }
}

module.exports = { sendFollowupReminder, testConnection }
