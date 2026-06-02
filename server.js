const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Database setup
const db = new Database('./database.sqlite');
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        name TEXT,
        bio TEXT,
        interests TEXT DEFAULT '[]'
    )
`);

function getUser(username) {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}
function getUserById(id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}
function createUser(username, passwordHash) {
    return db.prepare('INSERT INTO users (username, password, name) VALUES (?, ?, ?)')
        .run(username, passwordHash, username);
}
function updateUserProfile(username, name, bio, interests) {
    db.prepare('UPDATE users SET name = ?, bio = ?, interests = ? WHERE username = ?')
        .run(name, bio, JSON.stringify(interests), username);
}
function getAllUsersExcept(username) {
    return db.prepare('SELECT username, name, bio, interests FROM users WHERE username != ?').all(username);
}

// Session middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: 'birMillat-secret-key',
    resave: false,
    saveUninitialized: false,
    store: new SQLiteStore({ db: 'sessions.sqlite', dir: './' }),
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname)));

// ---------- Helper: render register page ----------
function renderRegisterPage(message, isError = true) {
    const msgClass = isError ? 'error' : 'success';
    return `<!DOCTYPE html><html><head><title>Ro'yxatdan o'tish - BirMillat</title><style>
        body{font-family:sans-serif;background:#f5f7fa;display:flex;justify-content:center;align-items:center;height:100vh}
        .card{background:white;border-radius:20px;padding:40px;width:350px;text-align:center;box-shadow:0 4px 12px rgba(0,0,0,0.1)}
        input{width:100%;padding:12px;margin:10px 0;border-radius:8px;border:1px solid #ddd}
        button{background:#c0392b;color:white;border:none;padding:12px;width:100%;border-radius:8px;cursor:pointer}
        .error{background:#ffe6e6;color:#c0392b;padding:8px;border-radius:6px;margin-bottom:15px}
        .success{background:#e6ffe6;color:#2e7d32;padding:8px;border-radius:6px;margin-bottom:15px}
        a{color:#c0392b}
    </style></head>
    <body><div class=card>
        <h2>Hisob yaratish</h2>
        ${message ? `<div class="${msgClass}">${message}</div>` : ''}
        <form method=post action=/register>
            <input name=username placeholder="Foydalanuvchi nomi" required>
            <input type=password name=password placeholder="Parol (kamida 8 belgi)" required>
            <button type=submit>Ro'yxatdan o'tish</button>
        </form>
        <p>Hisobingiz bormi? <a href=/login>Kirish</a></p>
    </div></body></html>`;
}

function renderLoginPage(errorMsg) {
    return `<!DOCTYPE html><html><head><title>Kirish - BirMillat</title><style>
        body{font-family:sans-serif;background:#f5f7fa;display:flex;justify-content:center;align-items:center;height:100vh}
        .card{background:white;border-radius:20px;padding:40px;width:350px;text-align:center;box-shadow:0 4px 12px rgba(0,0,0,0.1)}
        input{width:100%;padding:12px;margin:10px 0;border-radius:8px;border:1px solid #ddd}
        button{background:#c0392b;color:white;border:none;padding:12px;width:100%;border-radius:8px;cursor:pointer}
        .error{background:#ffe6e6;color:#c0392b;padding:8px;border-radius:6px;margin-bottom:15px}
        a{color:#c0392b}
    </style></head>
    <body><div class=card>
        <h2>Xush kelibsiz</h2>
        ${errorMsg ? `<div class="error">${errorMsg}</div>` : ''}
        <form method=post action=/login>
            <input name=username placeholder="Foydalanuvchi nomi" required>
            <input type=password name=password placeholder="Parol" required>
            <button type=submit>Kirish</button>
        </form>
        <p>Hisobingiz yo'q? <a href=/register>Ro'yxatdan o'tish</a></p>
    </div></body></html>`;
}

// Routes
app.get('/', (req, res) => {
    if (req.session.userId) return res.redirect('/home');
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/login', (req, res) => {
    if (req.session.userId) return res.redirect('/home');
    res.send(renderLoginPage(''));
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = getUser(username);
    if (!user) return res.send(renderLoginPage('❌ Login noto‘g‘ri'));
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.send(renderLoginPage('❌ Parol noto‘g‘ri'));
    req.session.userId = user.id;
    req.session.username = username;
    res.redirect('/home');
});

app.get('/register', (req, res) => {
    if (req.session.userId) return res.redirect('/home');
    res.send(renderRegisterPage(''));
});

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (password.length < 8) {
        return res.send(renderRegisterPage('Parol kamida 8 belgi bo‘lishi kerak', true));
    }
    const existing = getUser(username);
    if (existing) {
        return res.send(renderRegisterPage('Bunday foydalanuvchi mavjud', true));
    }
    const hashed = await bcrypt.hash(password, 10);
    createUser(username, hashed);
    res.send(renderRegisterPage('Muvaffaqiyatli ro‘yxatdan o‘tdingiz! <a href="/login">Kirishingiz</a> mumkin.', false));
});

app.get('/home', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'home.html'));
});

app.get('/profile', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'profile.html'));
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// API endpoints
app.get('/api/me', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    const user = getUserById(req.session.userId);
    res.json({ username: user.username, name: user.name, bio: user.bio, interests: JSON.parse(user.interests || '[]') });
});

app.get('/api/recommendations', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    const currentUser = getUserById(req.session.userId);
    const myInterests = JSON.parse(currentUser.interests || '[]');
    const allOthers = getAllUsersExcept(currentUser.username);
    // Compute match score based on common interests
    const scored = allOthers.map(u => {
        const theirInterests = JSON.parse(u.interests || '[]');
        const common = myInterests.filter(i => theirInterests.includes(i)).length;
        return { ...u, interests: theirInterests, matchScore: common };
    }).sort((a,b) => b.matchScore - a.matchScore);
    res.json(scored);
});

app.post('/api/profile/update', express.json(), (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    const { name, bio, interests } = req.body;
    const username = getUserById(req.session.userId).username;
    updateUserProfile(username, name, bio, interests);
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
