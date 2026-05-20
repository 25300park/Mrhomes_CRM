const router = require('express').Router()
const auth   = require('../middleware/auth')

// ── 고객 정보 파싱 프롬프트 ──────────────────────────────────
const CONTACT_PROMPT = `You are a real estate CRM data extractor for RBS Homes Philippines.
Parse the given text (Korean/English/mixed) and extract contact information.
Return ONLY valid JSON with no markdown, no explanation, no extra text.

Rules:
- contact_type: TENANT (임차인, renting), BUYER (매수인, buying), OWNER (임대인, owns property for rent), SELLER (매도인, selling), CO-BROKER
- If they are searching for property to rent → TENANT
- If they are searching to buy → BUYER
- platform: KakaoTalk, Telegram, Viber, WhatsApp, Line, SMS, Email, Other
- nationality: Korean, Filipino, Japanese, Chinese, American, Other
- budget: number in PHP (e.g. "35K" = 35000, "2억" or "200M" = 200000000)
- If lead info exists (they're looking for property), include "lead" object
- If no lead info, omit "lead" field
- For missing fields use null

JSON format:
{
  "name": "string or null",
  "mobile": "string or null",
  "email": "string or null",
  "contact_type": "TENANT|BUYER|OWNER|SELLER|CO-BROKER",
  "platform": "string or null",
  "nationality": "Korean",
  "remarks": "string or null",
  "lead": {
    "request_type": "RENT|BUY",
    "budget": number or null,
    "location_pref": "string or null",
    "property_type": "CONDO|OFFICE|COMMERCIAL|BUILDING|LAND|OTHER or null",
    "bedrooms_min": number or null,
    "move_in_date": "YYYY-MM or null",
    "remarks": "string or null"
  }
}`

// POST /api/ai/parse-contact
router.post('/parse-contact', auth, async (req, res) => {
  const { text } = req.body
  if (!text?.trim()) return res.status(400).json({ error: 'Text is required' })

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(500).json({
    error: 'ANTHROPIC_API_KEY not set',
    hint: 'Add ANTHROPIC_API_KEY to Render environment variables'
  })

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 800,
        system: CONTACT_PROMPT,
        messages: [{ role: 'user', content: text }]
      })
    })

    if (!response.ok) {
      const err = await response.json()
      return res.status(500).json({ error: 'Claude API error: ' + (err.error?.message || response.status) })
    }

    const data    = await response.json()
    const content = data.content?.[0]?.text || ''

    // JSON만 추출 (마크다운 코드블록 제거)
    const cleaned = content.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
    const parsed  = JSON.parse(cleaned)

    res.json({ success: true, data: parsed })
  } catch(e) {
    res.status(500).json({ error: 'Parsing failed: ' + e.message })
  }
})

module.exports = router
