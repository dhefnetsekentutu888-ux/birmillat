// BirMillat cookie consent banner.
//
// Loaded automatically by theme.js, which every page already includes, so no
// page needs its own <script> tag for it.
//
// What it does
//   - On a visitor's first visit it shows a small bar at the bottom of the page
//     (it never blocks the site) with two choices: accept all, or necessary only.
//   - The choice is remembered for 12 months in the first-party cookie
//     "bm_consent" (itself a strictly-necessary cookie).
//   - The privacy page has a "Cookie settings" button (data-cookie-settings)
//     that re-opens the bar so the choice can be changed or withdrawn.
//
// For future code (analytics, embeds, ...):
//   BMConsent.allows('optional')  -> true only if the visitor accepted all
//   window 'bm:consent' event     -> fires whenever the choice is saved
// Only load non-essential trackers after BMConsent.allows('optional') is true.
//
// Today BirMillat sets no analytics or advertising cookies; "necessary" covers
// the login session (connect.sid), the language (bm_lang) and this choice.
(function () {
    'use strict';
    if (window.BMConsent) return;

    var KEY = 'bm_consent';
    var VERSION = 1;
    var MAX_AGE = 365 * 24 * 60 * 60; // seconds

    var TEXT = {
        title: 'Cookie fayllari',
        text: 'BirMillat tizimga kirish, til va mavzu sozlamalari ishlashi uchun zarur cookie fayllaridan foydalanadi. Reklama va kuzatuv cookie\u2019lari ishlatilmaydi.',
        more: 'Batafsil',
        accept: 'Qabul qilaman',
        necessary: 'Faqat zarur'
    };

    function getCookie(name) {
        var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
        return m ? decodeURIComponent(m[1]) : null;
    }

    function readConsent() {
        var raw = getCookie(KEY);
        if (!raw) return null;
        try {
            var c = JSON.parse(raw);
            return (c && c.v === VERSION) ? c : null;
        } catch (e) {
            return null;
        }
    }

    function saveConsent(optional) {
        var c = { v: VERSION, necessary: true, optional: !!optional, ts: Date.now() };
        document.cookie = KEY + '=' + encodeURIComponent(JSON.stringify(c)) +
            '; max-age=' + MAX_AGE + '; path=/; SameSite=Lax' +
            (location.protocol === 'https:' ? '; Secure' : '');
        try { window.dispatchEvent(new CustomEvent('bm:consent', { detail: c })); } catch (e) {}
        return c;
    }

    var banner = null;

    function injectStyles() {
        if (document.getElementById('bm-consent-style')) return;
        var s = document.createElement('style');
        s.id = 'bm-consent-style';
        s.textContent =
            '.bm-consent{position:fixed;left:50%;bottom:1rem;transform:translateX(-50%);z-index:100000;' +
            'width:calc(100% - 2rem);max-width:760px;box-sizing:border-box;display:flex;align-items:center;gap:1.1rem;' +
            'padding:1rem 1.2rem;border-radius:16px;background:var(--color-surface,#fff);color:var(--color-text,#1A1625);' +
            'border:1px solid var(--color-border,#E8E2F0);box-shadow:0 12px 40px rgba(26,22,37,.22);' +
            'font-family:Inter,system-ui,sans-serif;animation:bm-consent-in .25s ease-out}' +
            '@keyframes bm-consent-in{from{opacity:0;transform:translate(-50%,12px)}to{opacity:1;transform:translate(-50%,0)}}' +
            '.bm-consent-body{flex:1;min-width:0}' +
            '.bm-consent-title{font-family:Sora,Inter,sans-serif;font-weight:700;font-size:.95rem;margin:0 0 .2rem}' +
            '.bm-consent-text{margin:0;font-size:.86rem;line-height:1.55;color:var(--color-text-muted,#6B6478)}' +
            '.bm-consent-text a{color:var(--color-primary,#2D1B69);font-weight:600;text-decoration:underline;white-space:nowrap}' +
            '.bm-consent-actions{display:flex;gap:.55rem;flex-shrink:0}' +
            '.bm-consent button{font:inherit;font-size:.86rem;font-weight:600;padding:.6rem 1rem;border-radius:10px;cursor:pointer;' +
            'white-space:nowrap;border:1px solid var(--color-border,#E8E2F0);background:transparent;color:var(--color-text,#1A1625)}' +
            '.bm-consent button:hover{border-color:var(--color-primary,#2D1B69)}' +
            '.bm-consent button:focus-visible{outline:2px solid var(--color-accent,#FF6B5B);outline-offset:2px}' +
            '.bm-consent .bm-consent-accept{background:var(--color-primary-solid,#2D1B69);border-color:var(--color-primary-solid,#2D1B69);color:#fff}' +
            '.bm-consent .bm-consent-accept:hover{background:var(--color-primary-light,#4A2F9E);border-color:var(--color-primary-light,#4A2F9E)}' +
            '@media (max-width:620px){.bm-consent{flex-direction:column;align-items:stretch;gap:.8rem;bottom:.6rem;width:calc(100% - 1.2rem)}' +
            '.bm-consent-actions{width:100%}.bm-consent-actions button{flex:1}}' +
            '@media (prefers-reduced-motion:reduce){.bm-consent{animation:none}}';
        document.head.appendChild(s);
    }

    function render() {
        if (!banner) return;
        var t = TEXT;
        banner.setAttribute('aria-label', t.title);
        banner.querySelector('.bm-consent-title').textContent = t.title;
        var p = banner.querySelector('.bm-consent-text');
        p.textContent = t.text + ' ';
        var a = document.createElement('a');
        a.href = '/privacy#cookies';
        a.textContent = t.more;
        p.appendChild(a);
        banner.querySelector('.bm-consent-necessary').textContent = t.necessary;
        banner.querySelector('.bm-consent-accept').textContent = t.accept;
    }

    function close() {
        if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
        banner = null;
    }

    function open() {
        if (banner) return;
        injectStyles();
        banner = document.createElement('div');
        banner.className = 'bm-consent';
        banner.setAttribute('role', 'dialog');
        banner.setAttribute('aria-live', 'polite');
        banner.innerHTML =
            '<div class="bm-consent-body">' +
            '<p class="bm-consent-title"></p><p class="bm-consent-text"></p></div>' +
            '<div class="bm-consent-actions">' +
            '<button type="button" class="bm-consent-necessary"></button>' +
            '<button type="button" class="bm-consent-accept"></button></div>';
        banner.querySelector('.bm-consent-necessary').addEventListener('click', function () { saveConsent(false); close(); });
        banner.querySelector('.bm-consent-accept').addEventListener('click', function () { saveConsent(true); close(); });
        document.body.appendChild(banner);
        render();
    }

    window.BMConsent = {
        get: readConsent,
        allows: function (category) {
            var c = readConsent();
            if (!c) return false;
            return category === 'necessary' ? true : !!c[category];
        },
        open: open
    };

    function init() {
        // Any element with data-cookie-settings re-opens the banner (privacy page).
        document.addEventListener('click', function (e) {
            var el = e.target.closest && e.target.closest('[data-cookie-settings]');
            if (el) { e.preventDefault(); open(); }
        });

        if (!readConsent()) open();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
