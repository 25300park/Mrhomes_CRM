self.addEventListener('push', event => {
  event.waitUntil(self.registration.showNotification('Time management reminder', {
    body: 'Please complete your daily reflection.',
    data: { url: '/time-management#reflection' }
  }))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil(clients.openWindow('/time-management#reflection'))
})
