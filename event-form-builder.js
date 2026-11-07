// Registration form builder (Google-Forms style) shared by /events/create and
// /events/:id/edit. Organizers can add up to 10 questions of five types:
// short answer, long answer, pick one, pick several, dropdown.
//
// Provides two globals used by the pages:
//   addQuestionRow(question)  - add one question card (an object, or a plain label)
//   collectQuestions()        - array ready for the server, or null if a
//                               choice question has fewer than 2 options
(function () {
    'use strict';

    var TYPES = [
        ['text', 'Qisqa javob'],
        ['paragraph', 'Uzun javob'],
        ['choice', 'Bitta variant tanlash'],
        ['checkbox', 'Bir nechta variant tanlash'],
        ['dropdown', "Ro'yxatdan tanlash"]
    ];
    var OPTION_TYPES = ['choice', 'checkbox', 'dropdown'];
    var MAX_QUESTIONS = 10;

    // One-tap starting points, so a form takes seconds instead of minutes.
    var TEMPLATES = [
        { chip: 'Ism-familiya', q: { label: "To'liq ism sharifingiz", type: 'text', required: true } },
        { chip: 'Telefon', q: { label: 'Telefon raqamingiz', type: 'text', required: true } },
        { chip: 'Telegram', q: { label: 'Telegram username', type: 'text', required: false } },
        { chip: 'Maktab / universitet', q: { label: "Maktab yoki universitetingiz", type: 'text', required: false } },
        { chip: 'Qayerdan bildingiz?', q: { label: 'Tadbir haqida qayerdan bildingiz?', type: 'choice', required: false,
            options: ['Telegram', 'Instagram', "Do'stim aytdi", 'BirMillat', 'Boshqa'] } }
    ];

    function injectStyles() {
        if (document.getElementById('qb-style')) return;
        var s = document.createElement('style');
        s.id = 'qb-style';
        s.textContent =
            '.qb-templates{display:flex;flex-wrap:wrap;gap:.45rem;margin:0 0 .9rem}' +
            '.qb-templates-label{font-size:.78rem;color:var(--color-text-muted);align-self:center;margin-right:.2rem}' +
            '.qb-chip{font:inherit;font-size:.8rem;font-weight:600;padding:.35rem .8rem;border-radius:999px;cursor:pointer;' +
            'border:1px dashed var(--color-border);background:var(--color-bg);color:var(--color-text)}' +
            '.qb-chip:hover{border-color:var(--color-primary);color:var(--color-primary)}' +
            '.qb-card{border:1px solid var(--color-border);border-radius:14px;padding:.85rem;margin-bottom:.8rem;background:var(--color-bg)}' +
            '.qb-top{display:flex;gap:.6rem;flex-wrap:wrap}' +
            '.qb-label{flex:1 1 220px;min-width:0;padding:.6rem .85rem;border-radius:10px;border:1px solid var(--color-border);' +
            'font:inherit;font-size:.9rem;background:var(--color-surface);color:var(--color-text)}' +
            '.qb-type{flex:0 1 210px;padding:.6rem .7rem;border-radius:10px;border:1px solid var(--color-border);' +
            'font:inherit;font-size:.85rem;background:var(--color-surface);color:var(--color-text)}' +
            '.qb-options{display:block;width:100%;box-sizing:border-box;margin-top:.6rem;padding:.6rem .85rem;border-radius:10px;' +
            'border:1px solid var(--color-border);font:inherit;font-size:.85rem;resize:vertical;background:var(--color-surface);color:var(--color-text)}' +
            '.qb-hint{font-size:.74rem;color:var(--color-text-muted);margin-top:.3rem}' +
            '.qb-foot{display:flex;align-items:center;justify-content:space-between;gap:.6rem;margin-top:.65rem}' +
            '.qb-req{display:flex;align-items:center;gap:.4rem;font-size:.82rem;color:var(--color-text-muted);cursor:pointer}' +
            '.qb-actions{display:flex;gap:.2rem}' +
            '.qb-icon{background:none;border:none;cursor:pointer;color:var(--color-text-muted);font-size:.9rem;padding:.4rem .55rem;border-radius:8px}' +
            '.qb-icon:hover{background:var(--color-surface);color:var(--color-primary)}' +
            '.qb-icon.qb-del:hover{color:var(--color-error)}' +
            '.qb-label:focus,.qb-type:focus,.qb-options:focus{outline:2px solid var(--color-accent);outline-offset:1px}';
        document.head.appendChild(s);
    }

    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text) e.textContent = text;
        return e;
    }

    function iconBtn(cls, icon, label, onClick) {
        var b = el('button', 'qb-icon ' + cls);
        b.type = 'button';
        b.setAttribute('aria-label', label);
        b.title = label;
        b.innerHTML = '<i class="fas ' + icon + '"></i>';
        b.addEventListener('click', onClick);
        return b;
    }

    function syncOptionsVisibility(card) {
        var type = card.querySelector('.qb-type').value;
        var box = card.querySelector('.qb-options-wrap');
        box.style.display = OPTION_TYPES.indexOf(type) !== -1 ? 'block' : 'none';
    }

    function listEl() { return document.getElementById('questionsList'); }
    function cardCount() { return document.querySelectorAll('.qb-card').length; }

    window.addQuestionRow = function (arg, requiredFlag) {
        injectStyles();
        var q = (arg && typeof arg === 'object') ? arg : { label: arg || '', required: !!requiredFlag };
        var card = el('div', 'qb-card');
        if (q.id) card.dataset.qid = q.id; // keeps attendees' saved answers attached when editing

        var top = el('div', 'qb-top');
        var label = el('input', 'qb-label');
        label.type = 'text';
        label.maxLength = 120;
        label.placeholder = 'Savol matni, masalan: To\u02bbliq ism sharifingiz';
        label.setAttribute('aria-label', 'Savol matni');
        label.value = q.label || '';
        var type = el('select', 'qb-type');
        type.setAttribute('aria-label', 'Javob turi');
        TYPES.forEach(function (t) {
            var o = el('option', '', t[1]);
            o.value = t[0];
            type.appendChild(o);
        });
        type.value = TYPES.some(function (t) { return t[0] === q.type; }) ? q.type : 'text';
        top.appendChild(label);
        top.appendChild(type);
        card.appendChild(top);

        var wrap = el('div', 'qb-options-wrap');
        var opts = el('textarea', 'qb-options');
        opts.rows = 3;
        opts.placeholder = 'Variantlar \u2014 har birini yangi qatordan yozing\nMasalan:\nBirinchi variant\nIkkinchi variant';
        opts.setAttribute('aria-label', 'Variantlar');
        opts.value = (q.options || []).join('\n');
        wrap.appendChild(opts);
        wrap.appendChild(el('div', 'qb-hint', 'Kamida 2 ta, ko\u02bbpi bilan 10 ta variant.'));
        card.appendChild(wrap);

        var foot = el('div', 'qb-foot');
        var reqLabel = el('label', 'qb-req');
        var req = document.createElement('input');
        req.type = 'checkbox';
        req.checked = !!q.required;
        reqLabel.appendChild(req);
        reqLabel.appendChild(document.createTextNode(' Majburiy'));
        var actions = el('div', 'qb-actions');
        actions.appendChild(iconBtn('qb-up', 'fa-arrow-up', 'Yuqoriga', function () {
            var prev = card.previousElementSibling;
            if (prev) card.parentNode.insertBefore(card, prev);
        }));
        actions.appendChild(iconBtn('qb-down', 'fa-arrow-down', 'Pastga', function () {
            var next = card.nextElementSibling;
            if (next) card.parentNode.insertBefore(next, card);
        }));
        actions.appendChild(iconBtn('qb-del', 'fa-trash', "O'chirish", function () { card.remove(); }));
        foot.appendChild(reqLabel);
        foot.appendChild(actions);
        card.appendChild(foot);

        type.addEventListener('change', function () { syncOptionsVisibility(card); });
        syncOptionsVisibility(card);
        listEl().appendChild(card);
        if (!q.label) label.focus();
        return card;
    };

    // null = a choice question has fewer than 2 options (the page shows its
    // "fill in all questions" message); rows with no question text are skipped.
    window.collectQuestions = function () {
        var out = [];
        var cards = document.querySelectorAll('.qb-card');
        for (var i = 0; i < cards.length; i++) {
            var card = cards[i];
            var label = card.querySelector('.qb-label').value.trim();
            if (!label) continue;
            var type = card.querySelector('.qb-type').value;
            var item = { label: label, type: type, required: card.querySelector('.qb-req input').checked };
            if (card.dataset.qid) item.id = card.dataset.qid;
            if (OPTION_TYPES.indexOf(type) !== -1) {
                var seen = {};
                var options = card.querySelector('.qb-options').value.split('\n')
                    .map(function (o) { return o.trim(); })
                    .filter(function (o) { if (!o || seen[o]) return false; seen[o] = true; return true; });
                if (options.length < 2 || options.length > 10) {
                    card.querySelector('.qb-options').focus();
                    return null;
                }
                item.options = options;
            }
            out.push(item);
        }
        return out;
    };

    function initTemplates() {
        var list = listEl();
        if (!list || document.getElementById('qbTemplates')) return;
        injectStyles();
        var bar = el('div', 'qb-templates');
        bar.id = 'qbTemplates';
        bar.appendChild(el('span', 'qb-templates-label', 'Tez qo\u02bbshish:'));
        TEMPLATES.forEach(function (t) {
            var b = el('button', 'qb-chip', '+ ' + t.chip);
            b.type = 'button';
            b.addEventListener('click', function () {
                if (cardCount() >= MAX_QUESTIONS) {
                    alert("Ko'pi bilan 10 ta savol qo'shishingiz mumkin");
                    return;
                }
                window.addQuestionRow(JSON.parse(JSON.stringify(t.q)));
            });
            bar.appendChild(b);
        });
        list.parentNode.insertBefore(bar, list);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initTemplates);
    else initTemplates();
})();
