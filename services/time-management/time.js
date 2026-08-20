const DEFAULT_BUSINESS_TIME_ZONE = 'Asia/Seoul'

function businessDateAt(date, zone = DEFAULT_BUSINESS_TIME_ZONE) {
  const value = date instanceof Date ? date : new Date(date)

  if (Number.isNaN(value.getTime())) {
    throw new TypeError('date must be a valid Date')
  }

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(value)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))

  return `${values.year}-${values.month}-${values.day}`
}

module.exports = {
  DEFAULT_BUSINESS_TIME_ZONE,
  businessDateAt
}
