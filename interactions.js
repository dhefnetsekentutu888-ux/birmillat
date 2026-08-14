/**
 * BirMillat — global micro-interaction engine
 * ------------------------------------------------------------
 * One script, loaded on every page, that gives every clickable
 * element press feedback without any per-page wiring. It:
 *
 *   1. Classifies whatever was clicked into a tier — low / mid /
 *      high / caution / toggle — using the element's class list,
 *      id, tag, role and text as signals (see TIER_RULES below).
 *   2. Plays the matching CSS animation (defined in style.css)
 *      via a short-lived class, and for "high" tier adds a
 *      ripple burst from the exact press point.
 *   3. Watches for the site's existing `btn.disabled = true`
 *      pattern (used during fetch calls) and swaps the frozen
 *      disabled look for a small loading-dots state, so waiting
 *      reads as "working" instead of "stuck".
 *   4. Adds a subtle hover-apart animation to the navbar logo's
 *      two rings (handled in CSS; this just needs the .logo
 *      element to exist, which it already does on every page).
 *
 * Nothing here required editing the 27 existing HTML pages —
 * it works by delegation from a single listener on `document`.
 */
(function () {
    'use strict';

    var prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // ---------- Tier classification ----------
    // Checked in order; first match wins. Keep the specific,
    // semantically-loaded rules first (caution/toggle/high) and
    // fall back to "low" for nav-style links, "mid" for anything
    // else clickable — so truly *every* clickable thing gets
    // something, but families share one pattern instead of each
    // button inventing its own.
    var CAUTION_WORDS = /delete|remove|cancel|report|block|leave|decline|reject|o'chirish|bekor|chiqish/i;
    var HIGH_CLASSES = /\b(btn-primary|ev-new-btn|lp-btn-primary|publish-btn|rsvp-btn|rsvp-choice-btn|vol-new-btn|scan-btn|btn-add|responder-msg-btn)\b/;
    var HIGH_WORDS = /join|rsvp|publish|register|ro'yxatdan|qatnashish|yubor|send|save|saqlash|subscribe|obuna|confirm|tasdiqlash|like/i;
    var TOGGLE_CLASSES = /\b(theme-toggle|nav-toggle|sidebar-close|notif-bell|mode-toggle)\b/;
    var LOW_CLASSES = /\b(filter-chip|ev-tab|mode-btn|team-chip)\b/;

    function classify(el) {
        var cls = el.className && el.className.baseVal !== undefined ? '' : (el.className || '');
        var id = el.id || '';
        var text = (el.textContent || '').trim();
        var signature = cls + ' ' + id;

        // Sidebar / top nav links — clicked constantly, stay ambient.
        if (el.closest('.nav-links') && el.tagName === 'A') return 'low';
        if (LOW_CLASSES.test(signature)) return 'low';

        // Toggles / reveals — icon flips rather than the button bouncing.
        if (TOGGLE_CLASSES.test(signature)) return 'toggle';

        // Destructive actions get a shake, checked before "high" so a
        // class like "btn-primary danger-btn" still reads as caution.
        if (/\bdanger-btn\b/.test(signature) || CAUTION_WORDS.test(signature) || CAUTION_WORDS.test(text)) {
            return 'caution';
        }

        // Primary commitment actions — the one big moment per screen.
        if (HIGH_CLASSES.test(signature)) return 'high';
        if (el.type === 'submit') return 'high';
        if (HIGH_WORDS.test(signature) || HIGH_WORDS.test(text)) return 'high';

        // Everything else clickable defaults to the calm, standard tier.
        return 'mid';
    }

    function isInteractive(el) {
        if (!el || el.nodeType !== 1) return false;
        var tag = el.tagName;
        if (tag === 'BUTTON') return true;
        if (tag === 'A' && el.hasAttribute('href')) return true;
        if (tag === 'INPUT' && /^(submit|button)$/.test(el.type)) return true;
        if (el.getAttribute('role') === 'button') return true;
        if (el.hasAttribute('onclick')) return true;
        var cls = el.className && typeof el.className === 'string' ? el.className : '';
        if (/\b(card|fab|chip|filter-chip|icon-action-btn|social-icon-btn|founder-social-btn|channel-card|vol-card|ticket-card)\b/.test(cls) && el.onclick) return true;
        return false;
    }

    function findInteractiveTarget(start) {
        var el = start;
        while (el && el !== document.body) {
            if (isInteractive(el)) return el;
            el = el.parentElement;
        }
        return null;
    }

    var ANIM_DURATIONS = { low: 150, mid: 240, high: 320, caution: 340, toggle: 320 };

    function playFeedback(el, tier, evt) {
        if (prefersReducedMotion) return;
        var animClass = 'bm-anim-' + tier;

        // Restart if it's already mid-animation (rapid re-clicks
        // shouldn't queue up or silently no-op).
        el.classList.remove(animClass);
        // eslint-disable-next-line no-unused-expressions
        void el.offsetWidth; // force reflow so re-adding the class replays it
        el.classList.add(animClass);
        window.setTimeout(function () {
            el.classList.remove(animClass);
        }, ANIM_DURATIONS[tier] + 30);

        if (tier === 'high') spawnRipple(el, evt);
    }

    function spawnRipple(el, evt) {
        var rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        var size = Math.max(rect.width, rect.height) * 1.4;
        var x = (evt && evt.clientX != null) ? evt.clientX - rect.left : rect.width / 2;
        var y = (evt && evt.clientY != null) ? evt.clientY - rect.top : rect.height / 2;

        el.classList.add('bm-ripple-wrap');
        var span = document.createElement('span');
        span.className = 'bm-ripple';
        span.style.width = span.style.height = size + 'px';
        span.style.left = (x - size / 2) + 'px';
        span.style.top = (y - size / 2) + 'px';
        el.appendChild(span);
        window.setTimeout(function () { span.remove(); }, 600);
    }

    // ---------- Delegated listeners ----------
    // pointerdown (not click) so the feedback starts the instant a
    // finger/cursor presses down — no waiting on the click's async
    // handler to resolve first, which was the root of the "zooms
    // then freezes" feeling.
    document.addEventListener('pointerdown', function (evt) {
        var target = findInteractiveTarget(evt.target);
        if (!target || target.disabled) return;
        var tier = classify(target);
        target.setAttribute('data-bm-tier', tier);
        playFeedback(target, tier, evt);
    }, { passive: true });

    // ---------- Disabled/loading state ----------
    // The app's existing async pattern is `btn.disabled = true`
    // while a fetch is in flight. Watch for that attribute flipping
    // and swap in the loading-dots look instead of the old frozen
    // scale-mid-transition state — no changes to any page's JS needed.
    var observer = new MutationObserver(function (mutations) {
        mutations.forEach(function (m) {
            var el = m.target;
            if (!(el.tagName === 'BUTTON' || (el.tagName === 'INPUT' && /submit|button/.test(el.type)))) return;
            if (el.disabled) {
                el.classList.add('bm-loading');
            } else {
                el.classList.remove('bm-loading');
            }
        });
    });

    function watchAllButtons() {
        document.querySelectorAll('button, input[type="submit"], input[type="button"]').forEach(function (el) {
            observer.observe(el, { attributes: true, attributeFilter: ['disabled'] });
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', watchAllButtons);
    } else {
        watchAllButtons();
    }

    // Buttons injected later (event lists, chat messages, etc.) —
    // pick those up too via a lightweight body-level observer.
    var bodyObserver = new MutationObserver(function (mutations) {
        mutations.forEach(function (m) {
            m.addedNodes && m.addedNodes.forEach(function (node) {
                if (node.nodeType !== 1) return;
                if (node.tagName === 'BUTTON' || (node.tagName === 'INPUT' && /submit|button/.test(node.type))) {
                    observer.observe(node, { attributes: true, attributeFilter: ['disabled'] });
                }
                if (node.querySelectorAll) {
                    node.querySelectorAll('button, input[type="submit"], input[type="button"]').forEach(function (el) {
                        observer.observe(el, { attributes: true, attributeFilter: ['disabled'] });
                    });
                }
            });
        });
    });
    document.addEventListener('DOMContentLoaded', function () {
        bodyObserver.observe(document.body, { childList: true, subtree: true });
    });
})();
