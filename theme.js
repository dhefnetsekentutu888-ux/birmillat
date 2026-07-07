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
        if (!btn) return;
        btn.addEventListener('click', function () {
            var current = document.documentElement.getAttribute('data-theme');
            var next = current === 'dark' ? 'light' : 'dark';
            localStorage.setItem(STORAGE_KEY, next);
            applyTheme(next);
        });
    });
})();

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
