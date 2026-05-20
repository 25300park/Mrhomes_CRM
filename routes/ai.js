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
        model: 'claude-haiku-4-5-20251001',
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

// ── 매물 정보 파싱 프롬프트 ──────────────────────────────────
const LISTING_PROMPT = `You are a real estate CRM data extractor for RBS Homes Philippines.
Parse the given text (Korean/English/mixed) and extract property listing information.
Return ONLY valid JSON with no markdown, no explanation, no extra text.

Rules:
- transaction_type: RENT (임대, rent, lease) or SALE (매매, sale, for sale)
- property_type: CONDO, OFFICE, COMMERCIAL, BUILDING, LAND, OTHER
- price: number in PHP. "35K"=35000, "2억"=200000000, "22.5M"=22500000, "₱55,550"=55550
- area_sqm: number (sqm, 평→multiply by 3.3)
- bedrooms: number (1BR=1, 2BR=2, Studio=0)
- bathrooms: number
- parking: number
- is_furnished: true if fully furnished/풀펀/full furnished, false otherwise
- pet_friendly: true if pets allowed/반려동물 가능, false if not allowed/불가
- floor: string (e.g. "22F", "3rd", "High floor")
- For missing fields use null
- If owner/lessor info is mentioned, include in "owner" object

JSON format:
{
  "name": "string (building name + unit, e.g. Bonifacio Ridge 1207B)",
  "transaction_type": "RENT|SALE",
  "property_type": "CONDO",
  "price": number or null,
  "area_sqm": number or null,
  "floor": "string or null",
  "bedrooms": number or null,
  "bathrooms": number or null,
  "parking": number or null,
  "is_furnished": true|false,
  "pet_friendly": true|false,
  "address": "string or null",
  "remarks": "string or null",
  "owner": {
    "name": "string or null",
    "mobile": "string or null",
    "platform": "string or null"
  }
}`

// POST /api/ai/parse-listing
router.post('/parse-listing', auth, async (req, res) => {
  const { text } = req.body
  if (!text?.trim()) return res.status(400).json({ error: 'Text is required' })

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' })

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        system: LISTING_PROMPT,
        messages: [{ role: 'user', content: text }]
      })
    })

    if (!response.ok) {
      const err = await response.json()
      return res.status(500).json({ error: 'Claude API error: ' + (err.error?.message || response.status) })
    }

    const data    = await response.json()
    const content = data.content?.[0]?.text || ''
    const cleaned = content.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
    const parsed  = JSON.parse(cleaned)

    res.json({ success: true, data: parsed })
  } catch(e) {
    res.status(500).json({ error: 'Parsing failed: ' + e.message })
  }
})

module.exports = router
