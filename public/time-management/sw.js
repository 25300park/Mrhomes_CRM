self.addEventListener('push', event => {
  const payload = event.data ? event.data.json() : {}
  event.waitUntil(self.registration.showNotification('Time management reminder', {
    body: typeof payload.body === 'string' ? payload.body : 'Please complete your daily reflection.',
    data: { url: '/time-management#reflection' }
  }))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil(clients.openWindow('/time-management#reflection'))
})
