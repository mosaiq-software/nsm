// NSM service worker: shows OS-level notifications for push messages from the leader, so deploy
// events surface even when the tab or the whole browser is closed.

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch (e) {
        data = { title: 'NSM', body: event.data ? event.data.text() : '' };
    }

    const title = data.title || 'NSM';
    const options = {
        body: data.body || '',
        tag: data.tag,
        renotify: Boolean(data.tag),
        data: { url: data.url || '/' },
        icon: '/favicon.svg',
        badge: '/favicon.svg',
    };

    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetUrl = (event.notification.data && event.notification.data.url) || '/';
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if ('focus' in client) {
                    if ('navigate' in client) {
                        client.navigate(targetUrl).catch(() => {});
                    }
                    return client.focus();
                }
            }
            if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
            return undefined;
        })
    );
});
