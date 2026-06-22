const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const { createClient } = require('@libsql/client');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Database setup (Turso / libSQL) ----------
// These two values come from Render's Environment tab — never hardcode them here.
const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN
});

// Ensure tables exist. This runs every boot but is safe (CREATE TABLE IF NOT EXISTS).
async function initDb() {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password TEXT,
            name TEXT,
            bio TEXT,
            interests TEXT DEFAULT '[]'
        )
    `);

    // Simple session store table (replaces connect-sqlite3, which wrote to local disk)
    await db.execute(`
        CREATE TABLE IF NOT EXISTS sessions (
            sid TEXT PRIMARY KEY,
            sess TEXT NOT NULL,
            expires INTEGER NOT NULL
        )
    `);
}

// ---------- Data access helpers (all async now) ----------
async function getUser(username) {
    const result = await db.execute({
        sql: 'SELECT * FROM users WHERE username = ?',
        args: [username]
    });
    return result.rows[0] || null;
}

async function getUserById(id) {
    const result = await db.execute({
        sql: 'SELECT * FROM users WHERE id = ?',
        args: [id]
    });
    return result.rows[0] || null;
}

async function createUser(username, passwordHash) {
    return db.execute({
        sql: 'INSERT INTO users (username, password, name) VALUES (?, ?, ?)',
        args: [username, passwordHash, username]
    });
}

async function updateUserProfile(username, name, bio, interests) {
    return db.execute({
        sql: 'UPDATE users SET name = ?, bio = ?, interests = ? WHERE username = ?',
        args: [name, bio, JSON.stringify(interests), username]
    });
}

async function getAllUsersExcept(username) {
    const result = await db.execute({
        sql: 'SELECT username, name, bio, interests FROM users WHERE username != ?',
        args: [username]
    });
    return result.rows;
}

// ---------- Custom session store backed by Turso ----------
// express-session expects a store with get/set/destroy (callback-style).
const Store = session.Store;
class TursoStore extends Store {
    get(sid, callback) {
        db.execute({ sql: 'SELECT sess, expires FROM sessions WHERE sid = ?', args: [sid] })
            .then(result => {
                const row = result.rows[0];
                if (!row) return callback(null, null);
                if (row.expires < Date.now()) {
                    return this.destroy(sid, () => callback(null, null));
                }
                callback(null, JSON.parse(row.sess));
            })
            .catch(err => callback(err));
    }

    set(sid, sessionData, callback) {
        const expires = Date.now() + (sessionData.cookie.maxAge || 24 * 60 * 60 * 1000);
        const sess = JSON.stringify(sessionData);
        db.execute({
            sql: `INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
                  ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires`,
            args: [sid, sess, expires]
        })
            .then(() => callback && callback(null))
            .catch(err => callback && callback(err));
    }

    destroy(sid, callback) {
        db.execute({ sql: 'DELETE FROM sessions WHERE sid = ?', args: [sid] })
            .then(() => callback && callback(null))
            .catch(err => callback && callback(err));
    }

    touch(sid, sessionData, callback) {
        this.set(sid, sessionData, callback);
    }
}

// Session middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'birMillat-secret-key',
    resave: false,
    saveUninitialized: false,
    store: new TursoStore(),
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname)));

// ---------- Helper: render pages ----------
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
    try {
        const { username, password } = req.body;
        const user = await getUser(username);
        if (!user) return res.send(renderLoginPage('❌ Login noto‘g‘ri'));
        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.send(renderLoginPage('❌ Parol noto‘g‘ri'));
        req.session.userId = user.id;
        req.session.username = username;
        res.redirect('/home');
    } catch (err) {
        console.error('Login error:', err);
        res.send(renderLoginPage('❌ Server xatosi, qaytadan urinib ko‘ring'));
    }
});

app.get('/register', (req, res) => {
    if (req.session.userId) return res.redirect('/home');
    res.send(renderRegisterPage(''));
});

app.post('/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password || password.length < 8) {
            return res.send(renderRegisterPage('Parol kamida 8 belgi bo‘lishi kerak', true));
        }
        const existing = await getUser(username);
        if (existing) {
            return res.send(renderRegisterPage('Bunday foydalanuvchi mavjud', true));
        }
        const hashed = await bcrypt.hash(password, 10);
        await createUser(username, hashed);
        res.send(renderRegisterPage('Muvaffaqiyatli ro‘yxatdan o‘tdingiz! <a href="/login">Kirishingiz</a> mumkin.', false));
    } catch (err) {
        console.error('Register error:', err);
        res.send(renderRegisterPage('❌ Server xatosi, qaytadan urinib ko‘ring', true));
    }
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
    req.session.destroy(() => {
        res.redirect('/');
    });
});

// API endpoints
app.get('/api/me', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const user = await getUserById(req.session.userId);
        if (!user) return res.status(401).json({ error: 'Unauthorized' });
        res.json({ username: user.username, name: user.name, bio: user.bio, interests: JSON.parse(user.interests || '[]') });
    } catch (err) {
        console.error('api/me error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/recommendations', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const currentUser = await getUserById(req.session.userId);
        const myInterests = JSON.parse(currentUser.interests || '[]');
        const allOthers = await getAllUsersExcept(currentUser.username);
        const scored = allOthers.map(u => {
            const theirInterests = JSON.parse(u.interests || '[]');
            const common = myInterests.filter(i => theirInterests.includes(i)).length;
            return { ...u, interests: theirInterests, matchScore: common };
        }).sort((a, b) => b.matchScore - a.matchScore);
        res.json(scored);
    } catch (err) {
        console.error('api/recommendations error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/profile/update', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const { name, bio, interests } = req.body;
        const user = await getUserById(req.session.userId);
        await updateUserProfile(user.username, name, bio, interests);
        res.json({ success: true });
    } catch (err) {
        console.error('api/profile/update error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ---------- Start server ----------
initDb()
    .then(() => {
        app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
    })
    .catch(err => {
        console.error('Failed to initialize database:', err);
        process.exit(1);
    });
