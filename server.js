const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const http = require('http');
const { Server: SocketIOServer } = require('socket.io');
const { createClient } = require('@libsql/client');

const app = express();
const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer);
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

    // Direct messages between two users
    await db.execute(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender_id INTEGER NOT NULL,
            receiver_id INTEGER NOT NULL,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            is_read INTEGER DEFAULT 0
        )
    `);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages (sender_id, receiver_id)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_messages_pair2 ON messages (receiver_id, sender_id)`);
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

async function searchUsers(currentUsername, query) {
    // Matches against username, name, and the raw interests JSON text (simple substring match)
    const likeQuery = `%${query}%`;
    const result = await db.execute({
        sql: `SELECT username, name, bio, interests FROM users
              WHERE username != ?
              AND (username LIKE ? OR name LIKE ? OR interests LIKE ?)
              LIMIT 50`,
        args: [currentUsername, likeQuery, likeQuery, likeQuery]
    });
    return result.rows;
}

async function getUsersByCategory(currentUsername, category) {
    const likeQuery = `%${category}%`;
    const result = await db.execute({
        sql: `SELECT username, name, bio, interests FROM users
              WHERE username != ? AND interests LIKE ?
              LIMIT 50`,
        args: [currentUsername, likeQuery]
    });
    return result.rows;
}

async function saveMessage(senderId, receiverId, content) {
    const createdAt = Date.now();
    const result = await db.execute({
        sql: `INSERT INTO messages (sender_id, receiver_id, content, created_at, is_read)
              VALUES (?, ?, ?, ?, 0)`,
        args: [senderId, receiverId, content, createdAt]
    });
    return { id: Number(result.lastInsertRowid), senderId, receiverId, content, createdAt };
}

async function getConversation(userIdA, userIdB) {
    const result = await db.execute({
        sql: `SELECT id, sender_id, receiver_id, content, created_at, is_read
              FROM messages
              WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
              ORDER BY created_at ASC
              LIMIT 200`,
        args: [userIdA, userIdB, userIdB, userIdA]
    });
    return result.rows;
}

async function getConversationList(userId) {
    // Latest message per counterpart, newest conversations first
    const result = await db.execute({
        sql: `
            SELECT u.username, u.name,
                   m.content AS last_message, m.created_at AS last_time,
                   m.sender_id AS last_sender_id
            FROM (
                SELECT
                    CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END AS other_id,
                    MAX(created_at) AS max_time
                FROM messages
                WHERE sender_id = ? OR receiver_id = ?
                GROUP BY other_id
            ) latest
            JOIN messages m ON (
                ((m.sender_id = ? AND m.receiver_id = latest.other_id) OR
                 (m.sender_id = latest.other_id AND m.receiver_id = ?))
                AND m.created_at = latest.max_time
            )
            JOIN users u ON u.id = latest.other_id
            ORDER BY m.created_at DESC
        `,
        args: [userId, userId, userId, userId, userId]
    });
    return result.rows;
}

async function markMessagesRead(senderId, receiverId) {
    await db.execute({
        sql: `UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0`,
        args: [senderId, receiverId]
    });
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

// Session middleware — created once, shared by both Express and Socket.IO below
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || 'birMillat-secret-key',
    resave: false,
    saveUninitialized: false,
    store: new TursoStore(),
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
});
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname)));

// ---------- Helper: render pages ----------
function renderRegisterPage(message, isError = true) {
    const msgClass = isError ? 'error' : 'success';
    return `<!DOCTYPE html><html><head><title>Ro'yxatdan o'tish - BirMillat</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/style.css">
    </head>
    <body class="auth-shell"><div class="auth-card">
        <h2>Hisob yaratish</h2>
        ${message ? `<div class="message ${msgClass}">${message}</div>` : ''}
        <form method=post action=/register>
            <input name=username placeholder="Foydalanuvchi nomi" required>
            <input type=password name=password placeholder="Parol (kamida 8 belgi)" required>
            <button type=submit>Ro'yxatdan o'tish</button>
        </form>
        <p>Hisobingiz bormi? <a href=/login>Kirish</a></p>
    </div></body></html>`;
}

function renderLoginPage(errorMsg) {
    return `<!DOCTYPE html><html><head><title>Kirish - BirMillat</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/style.css">
    </head>
    <body class="auth-shell"><div class="auth-card">
        <h2>Xush kelibsiz</h2>
        ${errorMsg ? `<div class="message error">${errorMsg}</div>` : ''}
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

app.get('/recommend', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'recommend.html'));
});

app.get('/search', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'search.html'));
});

app.get('/messages', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'messages.html'));
});

app.get('/profile', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'profile.html'));
});

app.get('/u/:username', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'view-profile.html'));
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

app.get('/api/search', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const q = (req.query.q || '').trim();
        const category = (req.query.category || '').trim();
        const currentUser = await getUserById(req.session.userId);

        let rows;
        if (q) {
            rows = await searchUsers(currentUser.username, q);
        } else if (category) {
            rows = await getUsersByCategory(currentUser.username, category);
        } else {
            rows = await getAllUsersExcept(currentUser.username);
        }

        const results = rows.map(u => ({ ...u, interests: JSON.parse(u.interests || '[]') }));
        res.json(results);
    } catch (err) {
        console.error('api/search error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/users/:username', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const user = await getUser(req.params.username);
        if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
        res.json({
            username: user.username,
            name: user.name,
            bio: user.bio,
            interests: JSON.parse(user.interests || '[]')
        });
    } catch (err) {
        console.error('api/users/:username error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/conversations', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const list = await getConversationList(req.session.userId);
        res.json(list);
    } catch (err) {
        console.error('api/conversations error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/messages/:username', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const otherUser = await getUser(req.params.username);
        if (!otherUser) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });

        const rows = await getConversation(req.session.userId, otherUser.id);
        await markMessagesRead(otherUser.id, req.session.userId);

        res.json({
            otherUser: { username: otherUser.username, name: otherUser.name },
            messages: rows.map(m => ({
                id: m.id,
                senderId: m.sender_id,
                content: m.content,
                createdAt: m.created_at,
                isMine: m.sender_id === req.session.userId
            }))
        });
    } catch (err) {
        console.error('api/messages/:username error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ---------- Real-time messaging (Socket.IO) ----------
// Track which socket(s) belong to which logged-in user, so we can push
// messages straight to them if they're online.
const onlineUsers = new Map(); // userId -> Set of socket ids

// Official Socket.IO v4 pattern: attach the same session middleware used by
// Express at the engine level so every socket gets req.session populated
// from the same cookie/store.
io.engine.use(sessionMiddleware);

io.on('connection', (socket) => {
    const session = socket.request.session;
    if (!session || !session.userId) {
        socket.disconnect(true);
        return;
    }
    const userId = session.userId;

    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId).add(socket.id);

    socket.on('send_message', async (data, callback) => {
        try {
            const { toUsername, content } = data || {};
            const trimmed = (content || '').trim();
            if (!toUsername || !trimmed) {
                if (callback) callback({ error: 'Xabar bo‘sh bo‘lishi mumkin emas' });
                return;
            }
            const receiver = await getUser(toUsername);
            if (!receiver) {
                if (callback) callback({ error: 'Foydalanuvchi topilmadi' });
                return;
            }

            const saved = await saveMessage(userId, receiver.id, trimmed);
            const payload = {
                id: saved.id,
                senderId: userId,
                receiverId: receiver.id,
                content: trimmed,
                createdAt: saved.createdAt
            };

            // Deliver to receiver if they're online right now
            const receiverSockets = onlineUsers.get(receiver.id);
            if (receiverSockets) {
                receiverSockets.forEach(sid => {
                    io.to(sid).emit('new_message', payload);
                });
            }

            if (callback) callback({ success: true, message: payload });
        } catch (err) {
            console.error('send_message error:', err);
            if (callback) callback({ error: 'Server xatosi' });
        }
    });

    socket.on('disconnect', () => {
        const sockets = onlineUsers.get(userId);
        if (sockets) {
            sockets.delete(socket.id);
            if (sockets.size === 0) onlineUsers.delete(userId);
        }
    });
});

// ---------- Start server ----------
initDb()
    .then(() => {
        httpServer.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
    })
    .catch(err => {
        console.error('Failed to initialize database:', err);
        process.exit(1);
    });
