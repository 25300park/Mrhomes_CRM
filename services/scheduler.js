const cron = require('node-cron')
const os = require('node:os')
const { sendFollowupReminder } = require('./mailer')
const { processReadyTimeJobs } = require('./time-management/job-queue')
const { createOpenAiReviewProvider, retryAiReview } = require('./time-management/ai-review')

function startScheduler(supabase) {
  const workerId = process.env.TIME_JOB_WORKER_ID || `${os.hostname()}:${process.pid}`
  const intervalMs = Math.max(15_000, Number(process.env.TIME_JOB_POLL_MS) || 60_000)
  const provider = createOpenAiReviewProvider({ apiKey: process.env.OPENAI_API_KEY })
  let processingJobs = false
  const processJobs = async () => {
    if (processingJobs) return
    processingJobs = true
    try {
      await processReadyTimeJobs({
        supabase,
        workerId,
        handlers: { AI_REVIEW: (job) => retryAiReview({ supabase, job, provider }) }
      })
    } catch (error) {
      console.error('[Scheduler] time job processing failed:', error.message)
    } finally {
      processingJobs = false
    }
  }
  const timeJobInterval = setInterval(processJobs, intervalMs)
  timeJobInterval.unref?.()

  // ── 매일 오전 8시 (필리핀 시간 Asia/Manila = UTC+8) ──────
  cron.schedule('0 8 * * *', async () => {
    console.log('[Scheduler] 팔로업 리마인더 실행 시작...')
    try {
      // 오늘 이전 팔로업이 있는 활성 리드 조회
      const { data: leads, error: leadsErr } = await supabase
        .from('v_leads_followup')
        .select('*')

      if (leadsErr) throw leadsErr
      if (!leads?.length) {
        console.log('[Scheduler] 오늘 팔로업 없음')
        return
      }

      // 활성 직원 목록 조회
      const { data: agents, error: agentsErr } = await supabase
        .from('users')
        .select('id, name, email')
        .eq('role', 'agent')
        .eq('is_active', true)
        .not('email', 'is', null)

      if (agentsErr) throw agentsErr

      // 직원별로 분류 후 이메일 발송
      let sent = 0
      for (const agent of agents) {
        const myLeads = leads.filter(l => l.assigned_user_id === agent.id)
        if (myLeads.length > 0) {
          await sendFollowupReminder(agent, myLeads)
          sent++
        }
      }

      console.log(`[Scheduler] ✓ 팔로업 알림 완료: ${leads.length}건 / ${sent}명 발송`)
    } catch(e) {
      console.error('[Scheduler] 오류:', e.message)
    }
  }, {
    timezone: 'Asia/Manila'
  })

  // ── 매일 오전 8시 5분: 만료 임박 계약 알림 ──────────────
  // (임대 계약 만료 30일 전 admin에게 알림)
  cron.schedule('5 8 * * *', async () => {
    try {
      const in30days = new Date()
      in30days.setDate(in30days.getDate() + 30)
      const dateStr = in30days.toISOString().split('T')[0]

      const { data: expiring } = await supabase
        .from('deals')
        .select('*, listing:listings(name), tenant_contact:contacts!deals_tenant_contact_id_fkey(name)')
        .eq('contract_type', 'RENT')
        .eq('status', 'ACTIVE')
        .lte('contract_end_date', dateStr)
        .gte('contract_end_date', new Date().toISOString().split('T')[0])

      if (!expiring?.length) return

      const { data: admin } = await supabase
        .from('users')
        .select('id, name, email')
        .eq('role', 'admin')
        .single()

      if (admin?.email) {
        const { sendFollowupReminder } = require('./mailer')
        // admin에게 만료 임박 계약 리스트 전송 (임시: console.log)
        console.log(`[Scheduler] 만료 임박 계약 ${expiring.length}건 (admin 알림 준비)`)
      }
    } catch(e) {
      console.error('[Scheduler] 계약 만료 체크 오류:', e.message)
    }
  }, { timezone: 'Asia/Manila' })

  console.log('📅 팔로업 스케줄러 시작 (매일 오전 8:00 필리핀 시간)')
}

module.exports = { startScheduler }
