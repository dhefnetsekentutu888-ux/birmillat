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

    // formatUzDate(ts): called from several pages (articles.html among them)
    // but was never actually defined anywhere client-side — only a same-named
    // server.js helper existed, which the browser can't reach. Every call was
    // throwing a ReferenceError, silently caught by the calling page's own
    // try/catch and shown as a generic "failed to load" instead of content.
    // Matches server.js's formatUzDateServer: Asia/Tashkent timezone (so it's
    // correct regardless of the visitor's or server's own timezone), "D Month
    // YYYY, HH:MM". Language-aware, same pattern as events.html's own month
    // tables, since there's no fixed DOM text here to snapshot a baseline from.
    var FULL_MONTHS = {
        uz: ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'],
        ru: ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'],
        en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
        qq: ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentyabr', 'oktyabr', 'noyabr', 'dekabr']
    };
    window.formatUzDate = function (ts) {
        var lang = (window.BirMillatI18n && window.BirMillatI18n.currentLang()) || 'uz';
        var months = FULL_MONTHS[lang] || FULL_MONTHS.uz;
        var parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Asia/Tashkent',
            day: 'numeric', month: 'numeric', year: 'numeric',
            hour: '2-digit', minute: '2-digit', hour12: false
        }).formatToParts(new Date(ts));
        function get(type) { return parts.find(function (p) { return p.type === type; }).value; }
        var day = get('day');
        var month = months[parseInt(get('month'), 10) - 1];
        var year = get('year');
        var hour = get('hour') === '24' ? '00' : get('hour');
        var minute = get('minute');
        return lang === 'en'
            ? (month + ' ' + day + ', ' + year + ', ' + hour + ':' + minute)
            : (day + ' ' + month + ' ' + year + ', ' + hour + ':' + minute);
    };

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

        // ---------- Sticky nav scroll shadow (shared across every page) ----------
        var navbar = document.querySelector('.navbar');
        if (navbar) {
            var onScroll = function () {
                navbar.classList.toggle('navbar-scrolled', window.scrollY > 8);
            };
            window.addEventListener('scroll', onScroll, { passive: true });
            onScroll();
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

        // ---------- Language switcher (shared across every page) ----------
        // The choice itself is cached by the browser, not by this script: it
        // lives in the bm_lang cookie (1-year expiry, set by server.js), so it
        // is sent back to the server automatically on every request and read
        // here on every page load — pick a language once, every page after
        // that already reflects it with no re-selection needed, until the
        // person explicitly changes it again.
        var LANGS = { uz: 'O\u02bbzbekcha', qq: 'Qaraqalpaqsha', ru: '\u0420\u0443\u0441\u0441\u043a\u0438\u0439', en: 'English' };
        var i18nCache = {};

        // The page's baseline text is already Uzbek, written directly in the
        // HTML — but only until the FIRST time some other language overwrites
        // it. After that, nothing in the DOM remembers what the original
        // Uzbek said, so switching back to uz had nothing to restore from and
        // silently did nothing. Fix: snapshot the real baseline once, right
        // now, before any translation has had a chance to run, and treat uz
        // as just another cached dictionary from then on — no special-casing.
        (function captureUzBaseline() {
            var dict = {};
            document.querySelectorAll('[data-i18n]').forEach(function (el) {
                dict[el.getAttribute('data-i18n')] = el.textContent;
            });
            document.querySelectorAll('[data-i18n-html]').forEach(function (el) {
                dict[el.getAttribute('data-i18n-html')] = el.innerHTML;
            });
            i18nCache.uz = dict;
        })();

        function getCookie(name) {
            var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
            return m ? decodeURIComponent(m[1]) : null;
        }

        function getPreferredLang() {
            var saved = getCookie('bm_lang');
            return (saved && LANGS[saved]) ? saved : 'uz';
        }

        function loadDict(lang) {
            if (i18nCache[lang]) return Promise.resolve(i18nCache[lang]);
            return fetch('/i18n/' + lang + '.json')
                .then(function (r) { return r.ok ? r.json() : {}; })
                .catch(function () { return {}; })
                .then(function (dict) { i18nCache[lang] = dict; return dict; });
        }

        // Pages that fetch their own content (volunteer/event/community cards,
        // recommended users, etc.) render it well after this script's initial
        // pass has already run, so anything they inject stays untranslated
        // unless that page's own code asks for another pass. Exposed globally
        // so any page can call window.BirMillatI18n.refresh() right after it
        // finishes writing new [data-i18n] elements into the DOM.
        window.BirMillatI18n = {
            currentLang: getPreferredLang,
            refresh: function () { return applyTranslations(getPreferredLang()); },
            // For sentences built with a number or search term plugged in
            // (e.g. "3 users found"), where there's no fixed DOM text to
            // snapshot as the uz baseline. Call with the Uzbek version as
            // `fallback`; a dictionary only needs the key if that language
            // has a translation for it. {name} in the template/fallback gets
            // replaced from vars.
            t: function (key, vars, fallback) {
                var lang = getPreferredLang();
                var dict = i18nCache[lang] || {};
                var template = dict[key] || fallback || key;
                return template.replace(/\{(\w+)\}/g, function (_, k) {
                    return (vars && vars[k] != null) ? vars[k] : '';
                });
            }
        };

        function applyTranslations(lang) {
            return loadDict(lang).then(function (dict) {
                document.querySelectorAll('[data-i18n]').forEach(function (el) {
                    var key = el.getAttribute('data-i18n');
                    if (dict[key]) el.textContent = dict[key];
                });
                // Trusted content only — these dictionaries are files we write
                // ourselves, never user input, so innerHTML here is safe.
                document.querySelectorAll('[data-i18n-html]').forEach(function (el) {
                    var key = el.getAttribute('data-i18n-html');
                    if (dict[key]) el.innerHTML = dict[key];
                });
                document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
                    var key = el.getAttribute('data-i18n-placeholder');
                    if (dict[key]) el.setAttribute('placeholder', dict[key]);
                });
            });
        }

        document.querySelectorAll('.lang-switcher').forEach(function (root) {
            var btn = root.querySelector('.lang-switcher-btn');
            var label = root.querySelector('.lang-switcher-label');
            var panel = root.querySelector('.lang-switcher-panel');
            if (!btn || !panel) return;

            function render(lang) {
                if (label) label.textContent = lang.toUpperCase();
                panel.querySelectorAll('.lang-option').forEach(function (opt) {
                    opt.classList.toggle('active', opt.dataset.lang === lang);
                });
            }

            function applyLang(lang, isUserChoice) {
                document.documentElement.setAttribute('lang', lang === 'qq' ? 'kaa' : lang);
                render(lang);
                applyTranslations(lang);
                if (isUserChoice) {
                    // The server sets the cookie (Set-Cookie on the response) and,
                    // for a logged-in user, saves it to their account — this is a
                    // same-origin fetch so the session cookie rides along automatically.
                    fetch('/api/lang', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ lang: lang })
                    }).catch(function () {});
                }
            }

            render(getPreferredLang());
            applyLang(getPreferredLang(), false);

            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                root.classList.toggle('open');
            });
            panel.querySelectorAll('.lang-option').forEach(function (opt) {
                opt.addEventListener('click', function () {
                    applyLang(opt.dataset.lang, true);
                    root.classList.remove('open');
                });
            });
            document.addEventListener('click', function (e) {
                if (root.classList.contains('open') && !root.contains(e.target)) root.classList.remove('open');
            });
        });

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

// ---------- Scroll-reveal (shared across every page) ----------
// Add class="reveal" to any element and it fades/rises into view the first
// time it enters the viewport — used by the redesigned pages instead of
// each one rolling its own IntersectionObserver. Elements added to the DOM
// later (e.g. cards rendered after a fetch) are picked up automatically by
// the MutationObserver below, so dynamic grids don't need extra wiring.
(function () {
    var prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function revealAll(items) {
        items.forEach(function (el) { el.classList.add('in-view'); });
    }

    document.addEventListener('DOMContentLoaded', function () {
        if (prefersReduced || !('IntersectionObserver' in window)) {
            revealAll(document.querySelectorAll('.reveal'));
            return;
        }

        var observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (entry.isIntersecting) {
                    entry.target.classList.add('in-view');
                    observer.unobserve(entry.target);
                }
            });
        }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });

        function observeNew(root) {
            (root.matches && root.matches('.reveal') ? [root] : [])
                .concat(Array.prototype.slice.call(root.querySelectorAll ? root.querySelectorAll('.reveal') : []))
                .forEach(function (el) {
                    if (!el.classList.contains('in-view')) observer.observe(el);
                });
        }

        observeNew(document.body);

        var mo = new MutationObserver(function (mutations) {
            mutations.forEach(function (m) {
                m.addedNodes.forEach(function (node) {
                    if (node.nodeType === 1) observeNew(node);
                });
            });
        });
        mo.observe(document.body, { childList: true, subtree: true });
    });
})();
