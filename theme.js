(function () {
    var STORAGE_KEY = 'birmillat-theme';

    function getPreferredTheme() {
        var saved = localStorage.getItem(STORAGE_KEY);
        if (saved === 'dark' || saved === 'light') return saved;
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    function updateToggleIcon(theme) {
        var btn = document.getElementById('themeToggle');
        if (!btn) return;
        btn.innerHTML = theme === 'dark'
            ? '<i class="fas fa-sun"></i>'
            : '<i class="fas fa-moon"></i>';
    }

    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        updateToggleIcon(theme);
    }

    // Runs immediately, before the stylesheet paints, so there's no flash
    // of the wrong theme on load.
    applyTheme(getPreferredTheme());

    document.addEventListener('DOMContentLoaded', function () {
        updateToggleIcon(document.documentElement.getAttribute('data-theme'));
        var btn = document.getElementById('themeToggle');
        if (btn) {
            btn.addEventListener('click', function () {
                var current = document.documentElement.getAttribute('data-theme');
                var next = current === 'dark' ? 'light' : 'dark';
                localStorage.setItem(STORAGE_KEY, next);
                applyTheme(next);
            });
        }

        // ---------- Sidebar navigation (shared across every page) ----------
        var sidebar = document.getElementById('navLinks');
        var toggle = document.getElementById('navToggle');
        var overlay = document.getElementById('sidebarOverlay');
        var closeBtn = document.getElementById('sidebarClose');

        function openSidebar() {
            if (sidebar) sidebar.classList.add('open');
            if (overlay) overlay.classList.add('open');
        }
        function closeSidebar() {
            if (sidebar) sidebar.classList.remove('open');
            if (overlay) overlay.classList.remove('open');
        }

        if (toggle) toggle.addEventListener('click', openSidebar);
        if (closeBtn) closeBtn.addEventListener('click', closeSidebar);
        if (overlay) overlay.addEventListener('click', closeSidebar);

        // ---------- Notification bell (only wired on pages that have it) ----------
        var bellBtn = document.getElementById('notifBell');
        var bellDot = document.getElementById('notifDot');
        var bellPanel = document.getElementById('notifPanel');
        var bellList = document.getElementById('notifList');

        if (bellBtn) {
            function refreshUnreadDot() {
                fetch('/api/notifications/unread-count')
                    .then(function (r) { return r.ok ? r.json() : { count: 0 }; })
                    .then(function (data) {
                        if (bellDot) bellDot.style.display = data.count > 0 ? 'block' : 'none';
                    })
                    .catch(function () {});
            }

            function timeAgo(ts) {
                var diff = Math.floor((Date.now() - ts) / 1000);
                if (diff < 60) return 'hozir';
                if (diff < 3600) return Math.floor(diff / 60) + ' daqiqa oldin';
                if (diff < 86400) return Math.floor(diff / 3600) + ' soat oldin';
                return Math.floor(diff / 86400) + ' kun oldin';
            }

            function loadNotifications() {
                if (!bellList) return;
                bellList.innerHTML = '<div class="notif-empty">Yuklanmoqda...</div>';
                fetch('/api/notifications')
                    .then(function (r) { return r.json(); })
                    .then(function (items) {
                        if (!items.length) {
                            bellList.innerHTML = '<div class="notif-empty">Hozircha bildirishnomalar yo\'q</div>';
                            return;
                        }
                        bellList.innerHTML = items.map(function (n) {
                            var href = n.link || '#';
                            return '<a href="' + href + '" class="notif-item' + (n.isRead ? '' : ' unread') + '">' +
                                '<div class="notif-text">' + n.content + '</div>' +
                                '<div class="notif-time">' + timeAgo(n.createdAt) + '</div>' +
                                '</a>';
                        }).join('');
                    })
                    .catch(function () {
                        bellList.innerHTML = '<div class="notif-empty">Yuklab bo\'lmadi</div>';
                    });
            }

            bellBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                var isOpen = bellPanel.classList.toggle('open');
                if (isOpen) {
                    loadNotifications();
                    fetch('/api/notifications/read-all', { method: 'POST' }).then(function () {
                        if (bellDot) bellDot.style.display = 'none';
                    });
                }
            });
            document.addEventListener('click', function (e) {
                if (bellPanel && bellPanel.classList.contains('open') && !bellPanel.contains(e.target) && e.target !== bellBtn) {
                    bellPanel.classList.remove('open');
                }
            });

            refreshUnreadDot();
            setInterval(refreshUnreadDot, 30000);

            // Register the service worker on any page with the bell, so push
            // notifications can arrive even when the site isn't open.
            if ('serviceWorker' in navigator) {
                navigator.serviceWorker.register('/sw.js').catch(function (e) {
                    console.error('Service worker registration failed:', e);
                });
            }
        }
    });
})();

// ---------- Web Push subscribe/unsubscribe (used by the profile page) ----------
function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - base64String.length % 4) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var rawData = window.atob(base64);
    var outputArray = new Uint8Array(rawData.length);
    for (var i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

window.BirMillatPush = {
    isSupported: function () {
        return 'serviceWorker' in navigator && 'PushManager' in window;
    },
    subscribe: function () {
        if (!this.isSupported()) return Promise.reject(new Error('Push not supported'));
        return navigator.serviceWorker.register('/sw.js')
            .then(function (reg) { return reg.pushManager.getSubscription().then(function (sub) { return { reg: reg, sub: sub }; }); })
            .then(function (result) {
                if (result.sub) return result.sub;
                return fetch('/api/push/vapid-public-key').then(function (r) { return r.json(); }).then(function (data) {
                    return result.reg.pushManager.subscribe({
                        userVisibleOnly: true,
                        applicationServerKey: urlBase64ToUint8Array(data.publicKey)
                    });
                });
            })
            .then(function (subscription) {
                return fetch('/api/push/subscribe', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(subscription)
                }).then(function () { return subscription; });
            });
    },
    unsubscribe: function () {
        if (!this.isSupported()) return Promise.resolve();
        return navigator.serviceWorker.getRegistration().then(function (reg) {
            if (!reg) return;
            return reg.pushManager.getSubscription().then(function (sub) {
                if (!sub) return;
                var endpoint = sub.endpoint;
                return sub.unsubscribe().then(function () {
                    return fetch('/api/push/unsubscribe', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ endpoint: endpoint })
                    });
                });
            });
        });
    }
};

// ---------- Shared Uzbek date formatting ----------
// toLocaleDateString('uz-UZ', ...) is unreliable across browsers — some ICU
// builds don't have full Uzbek month-name data and silently fall back to
// something like "M07" instead of "iyul". Building the string manually side-
// steps that entirely. Available globally since this loads on every page.
window.UZ_MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];

window.formatUzDate = function (ts, opts) {
    opts = opts || {};
    var d = new Date(ts);
    var parts = [d.getDate(), window.UZ_MONTHS[d.getMonth()]];
    if (opts.year !== false) parts.push(d.getFullYear());
    var result = parts.join(' ');
    if (opts.time) {
        var hh = String(d.getHours()).padStart(2, '0');
        var mm = String(d.getMinutes()).padStart(2, '0');
        result += ', ' + hh + ':' + mm;
    }
    return result;
};
