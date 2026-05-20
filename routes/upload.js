const router = require('express').Router()
const auth   = require('../middleware/auth')
const multer = require('multer')

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 최대 10MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true)
    else cb(new Error('이미지 파일만 업로드 가능합니다 (JPG, PNG, WEBP)'))
  }
})

// POST /api/upload/photo
router.post('/photo', auth, upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다' })

  const ext      = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase()
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
  const folder   = req.body.folder || 'listings'
  const path     = `${folder}/${filename}`

  const { error } = await req.supabase.storage
    .from('property-photos')
    .upload(path, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: false
    })

  if (error) return res.status(500).json({
    error: 'Supabase Storage 오류: ' + error.message,
    hint: 'Storage 버킷 "property-photos"가 생성되어 있는지 확인하세요'
  })

  const { data } = req.supabase.storage
    .from('property-photos')
    .getPublicUrl(path)

  res.json({ url: data.publicUrl, path })
})

// DELETE /api/upload/photo  (사진 삭제)
router.delete('/photo', auth, async (req, res) => {
  const { path } = req.body
  if (!path) return res.status(400).json({ error: 'path가 필요합니다' })

  const { error } = await req.supabase.storage
    .from('property-photos')
    .remove([path])

  if (error) return res.status(500).json({ error: error.message })
  res.json({ message: '삭제 완료' })
})

module.exports = router
