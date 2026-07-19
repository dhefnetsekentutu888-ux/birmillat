// BirMillat service worker — handles incoming push notifications and clicks
// on them. This is what makes notifications show up in the OS/browser
// notification tray (the "top shade on mobile") even when the site tab
// isn't open, the same way YouTube's mobile push notifications work.

self.addEventListener('push', function (event) {
    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch (e) {
        data = { title: 'BirMillat', body: event.data ? event.data.text() : '' };
    }

    const title = data.title || 'BirMillat';
    const options = {
        body: data.body || '',
        icon: '/favicon.png',
        badge: '/favicon.png',
        data: { link: data.link || '/home' }
    };

    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
    event.notification.close();
    const link = (event.notification.data && event.notification.data.link) || '/home';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
            for (const client of clientList) {
                if (client.url.includes(link) && 'focus' in client) {
                    return client.focus();
                }
            }
            if (clients.openWindow) {
                return clients.openWindow(link);
            }
        })
    );
});
