// routes/pms-documents.js
// PMS 문서함 관리 — Listing Report / LOI 전송 및 전자서명

const router  = require('express').Router()
const auth    = require('../middleware/auth')
const nodemailer = require('nodemailer')

function getTransporter() {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) return null
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
  })
}

// ── GET /api/pms-documents?contact_id=
router.get('/', auth, async (req, res) => {
  try {
    const { contact_id, type } = req.query
    let query = req.supabase
      .from('pms_documents')
      .select('*')
      .order('sent_at', { ascending: false })

    if (contact_id) query = query.eq('contact_id', contact_id)
    if (type)       query = query.eq('type', type)

    const { data, error } = await query
    if (error) return res.status(500).json({ error: error.message })
    res.json(data || [])
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── POST /api/pms-documents/send-listing-report
// Listing Report → PMS 문서함 전송 + 이메일 발송
router.post('/send-listing-report', auth, async (req, res) => {
  try {
    const { report_id, contact_id } = req.body
    if (!report_id || !contact_id) {
      return res.status(400).json({ error: 'report_id와 contact_id가 필요합니다.' })
    }

    // listing_report 조회
    const { data: report } = await req.supabase
      .from('listing_reports')
      .select('*')
      .eq('id', report_id)
      .single()
    if (!report) return res.status(404).json({ error: 'Listing Report를 찾을 수 없습니다.' })

    // contact 조회
    const { data: contact } = await req.supabase
      .from('contacts')
      .select('id, name, email')
      .eq('id', contact_id)
      .single()
    if (!contact) return res.status(404).json({ error: '고객 정보를 찾을 수 없습니다.' })
    if (!contact.email) return res.status(400).json({ error: '고객 이메일이 없습니다.' })

    // listing 상세 조회
    const listingIds = report.listing_ids || []
    let listingsHtml = ''
    if (listingIds.length > 0) {
      const { data: listings } = await req.supabase
        .from('listings')
        .select('id, name, unit_no, address, price, bedrooms, bathrooms, area_sqm, photos')
        .in('id', listingIds)

      listingsHtml = (listings || []).map((l, i) => {
        const photo = Array.isArray(l.photos) && l.photos[0] ? l.photos[0] : null
        return `
        <div style="border:1px solid #EAE6DF;border-radius:10px;overflow:hidden;margin-bottom:16px">
          ${photo ? `<img src="${photo}" style="width:100%;height:180px;object-fit:cover">` : ''}
          <div style="padding:14px 16px">
            <div style="font-size:15px;font-weight:700;color:#1C3553;margin-bottom:4px">
              ${i+1}. ${l.name}${l.unit_no ? ' ' + l.unit_no : ''}
            </div>
            <div style="font-size:12px;color:#6B7280;margin-bottom:8px">${l.address || ''}</div>
            <div style="display:flex;gap:12px;font-size:12px;color:#374151">
              ${l.bedrooms ? `<span>🛏 ${l.bedrooms}BR</span>` : ''}
              ${l.bathrooms ? `<span>🚿 ${l.bathrooms}Bath</span>` : ''}
              ${l.area_sqm ? `<span>📐 ${l.area_sqm}㎡</span>` : ''}
              ${l.price ? `<span style="font-weight:700;color:#1C3553">₱${Math.round(l.price).toLocaleString('en-PH')}/월</span>` : ''}
            </div>
          </div>
        </div>`
      }).join('')
    }

    // pms_documents에 저장
    const { data: doc, error: docError } = await req.supabase
      .from('pms_documents')
      .insert({
        contact_id,
        type: 'LISTING_REPORT',
        title: `Listing Report — ${report.report_date}`,
        html_content: listingsHtml,
        status: 'SENT',
        sent_by: req.user.id,
        related_id: report_id,
      })
      .select().single()

    if (docError) return res.status(500).json({ error: docError.message })

    // 이메일 발송
    const transporter = getTransporter()
    if (transporter) {
      const pmsUrl = process.env.PMS_URL || 'https://mrhomes-pms.vercel.app'
      const html = `
<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
<style>
  body{font-family:-apple-system,sans-serif;margin:0;background:#F4F1EC}
  .wrap{max-width:560px;margin:0 auto}
  .header{background:#1C3553;color:#fff;padding:24px 28px}
  .header h2{margin:0 0 4px;font-size:18px}
  .header p{margin:0;font-size:13px;opacity:.6}
  .body{background:#fff;padding:24px 28px}
  .cta{text-align:center;padding:24px 0}
  .cta a{background:#1C3553;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:600}
  .footer{background:#F8F5F0;padding:16px 28px;font-size:11px;color:#6B7280;text-align:center}
</style></head><body>
<div class="wrap">
  <div class="header"><h2>🏠 mrhomes</h2><p>매물 추천 리포트</p></div>
  <div class="body">
    <p style="font-size:15px;color:#1C3553">안녕하세요, <strong>${contact.name}</strong>님</p>
    <p style="font-size:14px;color:#374151;line-height:1.7">
      고객님을 위해 선별한 ${listingIds.length}개의 매물을 안내드립니다.<br>
      아래 버튼을 클릭하여 mrhomes 앱에서 상세 내용을 확인하세요.
    </p>
    ${listingsHtml}
    <div class="cta">
      <a href="${pmsUrl}/documents">mrhomes 앱에서 확인하기 →</a>
    </div>
  </div>
  <div class="footer">mrhomes · 이 메일은 자동 발송됩니다</div>
</div></body></html>`

      await transporter.sendMail({
        from: `"mrhomes" <${process.env.EMAIL_USER}>`,
        to: contact.email,
        subject: `[mrhomes] 추천 매물 ${listingIds.length}건이 도착했습니다`,
        html
      }).catch(e => console.warn('[Mailer] 발송 실패:', e.message))
    }

    res.json({ message: 'PMS 문서함에 전송되었습니다.', doc_id: doc.id, email_sent: !!transporter })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── POST /api/pms-documents/send-loi
// LOI → PMS 문서함 전송 + 이메일 발송
router.post('/send-loi', auth, async (req, res) => {
  try {
    const { loi_id, contact_id } = req.body
    if (!loi_id || !contact_id) {
      return res.status(400).json({ error: 'loi_id와 contact_id가 필요합니다.' })
    }

    const { data: loi } = await req.supabase
      .from('loi_documents')
      .select('*')
      .eq('id', loi_id)
      .single()
    if (!loi) return res.status(404).json({ error: 'LOI를 찾을 수 없습니다.' })

    const { data: contact } = await req.supabase
      .from('contacts')
      .select('id, name, email')
      .eq('id', contact_id)
      .single()
    if (!contact) return res.status(404).json({ error: '고객 정보를 찾을 수 없습니다.' })
    if (!contact.email) return res.status(400).json({ error: '고객 이메일이 없습니다.' })

    // 기존 LOI 전송 여부 확인
    const { data: existing } = await req.supabase
      .from('pms_documents')
      .select('id')
      .eq('related_id', loi_id)
      .eq('contact_id', contact_id)
      .eq('type', 'LOI')
      .single()

    let doc
    if (existing) {
      // 이미 있으면 html_content 업데이트 + status 재설정
      const { data: updated } = await req.supabase
        .from('pms_documents')
        .update({
          html_content: loi.html_content,
          status: 'SENT',
          signature_data: null,
          signed_at: null,
          sent_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select().single()
      doc = updated
    } else {
      const { data: inserted, error: docError } = await req.supabase
        .from('pms_documents')
        .insert({
          contact_id,
          type: 'LOI',
          title: `LOI — ${loi.property_name || ''} ${loi.loi_date || ''}`.trim(),
          html_content: loi.html_content,
          status: 'SENT',
          sent_by: req.user.id,
          related_id: loi_id,
        })
        .select().single()
      if (docError) return res.status(500).json({ error: docError.message })
      doc = inserted
    }

    // 이메일 발송
    const transporter = getTransporter()
    if (transporter) {
      const pmsUrl = process.env.PMS_URL || 'https://mrhomes-pms.vercel.app'
      const html = `
<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
<style>
  body{font-family:-apple-system,sans-serif;margin:0;background:#F4F1EC}
  .wrap{max-width:560px;margin:0 auto}
  .header{background:#1C3553;color:#fff;padding:24px 28px}
  .body{background:#fff;padding:24px 28px}
  .loi-box{background:#F8F5F0;border-radius:10px;padding:16px;margin:16px 0;font-size:13px;line-height:1.8}
  .cta{text-align:center;padding:24px 0}
  .cta a{background:#1C3553;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:600}
  .footer{background:#F8F5F0;padding:16px 28px;font-size:11px;color:#6B7280;text-align:center}
</style></head><body>
<div class="wrap">
  <div class="header" style="display:flex;justify-content:space-between;align-items:center">
    <div><h2 style="margin:0 0 4px;font-size:18px">🏠 mrhomes</h2><p style="margin:0;font-size:13px;opacity:.6">Letter of Intent 안내</p></div>
  </div>
  <div class="body">
    <p style="font-size:15px;color:#1C3553">안녕하세요, <strong>${contact.name}</strong>님</p>
    <p style="font-size:14px;color:#374151;line-height:1.7">
      임대 의향서(LOI)가 작성되었습니다.<br>
      아래 버튼을 클릭하여 내용을 검토하고 서명 또는 수정 요청을 진행해 주세요.
    </p>
    <div class="loi-box">
      <strong>📋 ${loi.property_name || ''}${loi.unit_no ? ' ' + loi.unit_no : ''}</strong><br>
      ${loi.monthly_rent ? `월 임대료: ₱${Number(loi.monthly_rent).toLocaleString('en-PH')}` : ''}<br>
      ${loi.duration ? `계약 기간: ${loi.duration}개월` : ''}<br>
      ${loi.movein_date ? `입주 예정: ${loi.movein_date}` : ''}
    </div>
    <div class="cta">
      <a href="${pmsUrl}/documents">LOI 검토 및 서명하기 →</a>
    </div>
  </div>
  <div class="footer">mrhomes · 이 메일은 자동 발송됩니다</div>
</div></body></html>`

      await transporter.sendMail({
        from: `"mrhomes" <${process.env.EMAIL_USER}>`,
        to: contact.email,
        subject: `[mrhomes] 임대 의향서(LOI)가 도착했습니다 — 서명 요청`,
        html
      }).catch(e => console.warn('[Mailer] 발송 실패:', e.message))
    }

    res.json({ message: 'LOI가 PMS 문서함으로 전송되었습니다.', doc_id: doc.id, email_sent: !!transporter })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── PATCH /api/pms-documents/:id/sign
// 전자서명 저장 (PMS에서 호출)
router.patch('/:id/sign', auth, async (req, res) => {
  try {
    const { signature_data, comment } = req.body
    if (!signature_data) return res.status(400).json({ error: '서명 데이터가 없습니다.' })

    const { data, error } = await req.supabase
      .from('pms_documents')
      .update({
        status: 'SIGNED',
        signature_data,
        signed_at: new Date().toISOString(),
        comment: comment || null,
      })
      .eq('id', req.params.id)
      .select().single()

    if (error) return res.status(500).json({ error: error.message })

    // CRM에 알림 저장
    if (data.sent_by) {
      await req.supabase.from('notifications').insert({
        user_id:  data.sent_by,
        type:     'PMS_SIGN',
        title:    'LOI 전자서명 완료',
        body:     `${data.title}에 고객이 서명했습니다.`,
        related_id: data.id,
      }).catch(() => {})
    }

    res.json(data)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── PATCH /api/pms-documents/:id/comment
// 수정 요청 저장 (PMS에서 호출)
router.patch('/:id/comment', auth, async (req, res) => {
  try {
    const { comment } = req.body
    const { data, error } = await req.supabase
      .from('pms_documents')
      .update({ status: 'COMMENT_REQUESTED', comment })
      .eq('id', req.params.id)
      .select().single()

    if (error) return res.status(500).json({ error: error.message })
    res.json(data)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

module.exports = router
