// routes/pms-accounts.js
// PMS 임차인/임대인 계정 관리 API
// Supabase Auth + pms_auth_map 자동 연결

const router = require('express').Router()
const auth   = require('../middleware/auth')
const { createClient } = require('@supabase/supabase-js')

// service_role 클라이언트 (Auth 사용자 생성용)
// req.supabase는 일반 클라이언트라 Auth admin 기능이 없음
function getAdminClient() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

// ── GET /api/pms-accounts/deal/:dealId
// 해당 계약의 PMS 계정 연결 상태 조회
router.get('/deal/:dealId', auth, async (req, res) => {
  try {
    const { dealId } = req.params

    // deal 정보 조회
    const { data: deal } = await req.supabase
      .from('deals')
      .select(`
        id, monthly_rent, status,
        tenant_contact:contacts!deals_tenant_contact_id_fkey(id, name, email, mobile),
        owner_contact:contacts!deals_owner_contact_id_fkey(id, name, email, mobile),
        listing:listings(id, name, unit_no)
      `)
      .eq('id', dealId)
      .single()

    if (!deal) return res.status(404).json({ error: '계약을 찾을 수 없습니다.' })

    // pms_auth_map 조회
    const { data: maps } = await req.supabase
      .from('pms_auth_map')
      .select('auth_uid, contact_id, role, created_at')
      .in('contact_id', [
        deal.tenant_contact?.id,
        deal.owner_contact?.id
      ].filter(Boolean))

    const tenantMap = maps?.find(m => m.contact_id === deal.tenant_contact?.id)
    const landlordMap = maps?.find(m => m.contact_id === deal.owner_contact?.id)

    res.json({
      deal,
      pms_accounts: {
        tenant: {
          contact: deal.tenant_contact,
          auth_uid: tenantMap?.auth_uid || null,
          connected: !!tenantMap,
          created_at: tenantMap?.created_at || null,
        },
        landlord: {
          contact: deal.owner_contact,
          auth_uid: landlordMap?.auth_uid || null,
          connected: !!landlordMap,
          created_at: landlordMap?.created_at || null,
        }
      }
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── GET /api/pms-accounts/contact/:contactId
// contact_id로 PMS 계정 연결 상태 조회
router.get('/contact/:contactId', auth, async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from('pms_auth_map')
      .select('auth_uid, contact_id, role, created_at')
      .eq('contact_id', req.params.contactId)
    if (error) return res.status(500).json({ error: error.message })
    res.json(data?.map(m => ({ ...m, connected: true })) || [])
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── POST /api/pms-accounts/create
// PMS 계정 생성 + pms_auth_map 연결
router.post('/create', auth, async (req, res) => {
  // admin/agent 모두 계정 생성 가능

  try {
    const { contact_id, role, temp_password } = req.body
    if (!contact_id || !role) return res.status(400).json({ error: 'contact_id와 role이 필요합니다.' })
    if (!['tenant', 'landlord', 'prospective'].includes(role)) return res.status(400).json({ error: 'role은 tenant, landlord, prospective 이어야 합니다.' })

    // contact 정보 조회
    const { data: contact } = await req.supabase
      .from('contacts')
      .select('id, name, email, mobile')
      .eq('id', contact_id)
      .single()

    if (!contact) return res.status(404).json({ error: '고객 정보를 찾을 수 없습니다.' })
    if (!contact.email) return res.status(400).json({ error: '이메일 주소가 없습니다. Contacts에서 이메일을 먼저 등록해주세요.' })

    // 이미 pms_auth_map에 있는지 확인
    const { data: existing } = await req.supabase
      .from('pms_auth_map')
      .select('auth_uid')
      .eq('contact_id', contact_id)
      .single()

    if (existing) return res.status(400).json({ error: '이미 PMS 계정이 연결되어 있습니다.' })

    const adminClient = getAdminClient()
    const password = temp_password || generateTempPassword()

    // Supabase Auth 사용자 생성
    const { data: authUser, error: authError } = await adminClient.auth.admin.createUser({
      email:          contact.email,
      password,
      email_confirm:  true,  // 이메일 확인 없이 바로 활성화
      user_metadata:  { full_name: contact.name, role },
    })

    if (authError) {
      // 이미 Auth에 계정이 있는 경우
      if (authError.message.includes('already been registered')) {
        // 기존 Auth 사용자 찾기
        const { data: users } = await adminClient.auth.admin.listUsers()
        const existingUser = users?.users?.find(u => u.email === contact.email)

        if (existingUser) {
          // pms_auth_map만 연결
          const { error: mapError } = await req.supabase
            .from('pms_auth_map')
            .insert({ auth_uid: existingUser.id, contact_id, role })

          if (mapError) return res.status(500).json({ error: mapError.message })

          return res.json({
            message: '기존 Auth 계정에 PMS 권한을 연결했습니다.',
            auth_uid: existingUser.id,
            email: contact.email,
            existing_account: true,
          })
        }
      }
      return res.status(500).json({ error: authError.message })
    }

    // pms_auth_map 연결
    const { error: mapError } = await req.supabase
      .from('pms_auth_map')
      .insert({ auth_uid: authUser.user.id, contact_id, role })

    if (mapError) {
      // 롤백: 생성된 Auth 계정 삭제
      await adminClient.auth.admin.deleteUser(authUser.user.id)
      return res.status(500).json({ error: mapError.message })
    }

    res.json({
      message: 'PMS 계정이 생성되었습니다.',
      auth_uid: authUser.user.id,
      email:    contact.email,
      temp_password: password,
      name:     contact.name,
      role,
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── POST /api/pms-accounts/reset-password
// 임시 비밀번호 재설정
router.post('/reset-password', auth, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: '관리자만 비밀번호를 재설정할 수 있습니다.' })
  }

  try {
    const { auth_uid } = req.body
    if (!auth_uid) return res.status(400).json({ error: 'auth_uid가 필요합니다.' })

    const adminClient = getAdminClient()
    const newPassword = generateTempPassword()

    const { error } = await adminClient.auth.admin.updateUserById(auth_uid, {
      password: newPassword
    })

    if (error) return res.status(500).json({ error: error.message })

    res.json({ message: '비밀번호가 재설정되었습니다.', temp_password: newPassword })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── DELETE /api/pms-accounts/:contactId
// PMS 계정 연결 해제 (Auth 계정은 유지, map만 삭제)
router.delete('/:contactId', auth, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: '관리자만 계정 연결을 해제할 수 있습니다.' })
  }

  try {
    const { error } = await req.supabase
      .from('pms_auth_map')
      .delete()
      .eq('contact_id', req.params.contactId)

    if (error) return res.status(500).json({ error: error.message })
    res.json({ message: 'PMS 계정 연결이 해제되었습니다.' })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── 임시 비밀번호 생성 ────────────────────────────────────
function generateTempPassword() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  let pwd = ''
  for (let i = 0; i < 10; i++) {
    pwd += chars[Math.floor(Math.random() * chars.length)]
  }
  return pwd + '!'  // 특수문자 포함으로 정책 충족
}

module.exports = router
