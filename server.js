const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);

// ---------- SQLite Database ----------
const db = new sqlite3.Database('./database.sqlite');
db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    friends TEXT DEFAULT '[]',
    friendRequests TEXT DEFAULT '[]',
    blocked TEXT DEFAULT '[]'
)`);

function getUser(username, callback) {
    db.get('SELECT * FROM users WHERE username = ?', [username], callback);
}
function createUser(username, passwordHash, callback) {
    db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, passwordHash], callback);
}
function updateUserSocial(username, field, value, callback) {
    db.run(`UPDATE users SET ${field} = ? WHERE username = ?`, [JSON.stringify(value), username], callback);
}

// ---------- Session Middleware ----------
const sessionMiddleware = session({
    secret: 'birMillat-secret-key-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
});

app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname))); // serve logo.png, etc.

// ---------- Socket.IO with session support ----------
const io = new Server(server);
io.use((socket, next) => {
    cookieParser()(socket.request, socket.request.res || {}, (err) => {
        if (err) return next(err);
        sessionMiddleware(socket.request, socket.request.res || {}, next);
    });
});

// ========== PUBLIC HOME PAGE (light background, Uzbek) ==========
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html>
<head><title>BirMillat – Qiziqishlaringiz bilan insonlarni toping</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',sans-serif;background:#f5f7fa;color:#2c3e50}
.container{max-width:1200px;margin:0 auto;padding:20px}
header{display:flex;justify-content:space-between;align-items:center;padding:20px 0;flex-wrap:wrap}
.logo{font-size:28px;font-weight:bold;display:flex;align-items:center;gap:10px}
.logo img{height:40px}
.nav-buttons a{color:#2c3e50;text-decoration:none;background:#e2e8f0;padding:10px 20px;border-radius:30px;margin-left:10px;transition:0.3s}
.nav-buttons a:hover{background:#cbd5e1}
.hero{text-align:center;padding:80px 20px}
.hero h1{font-size:48px;margin-bottom:20px;color:#c0392b}
.btn{background:#c0392b;color:white;padding:12px 30px;border-radius:40px;text-decoration:none;display:inline-block;margin:10px;transition:0.3s}
.btn:hover{background:#a93226}
.btn-outline{background:transparent;border:2px solid #c0392b;color:#c0392b}
.btn-outline:hover{background:#c0392b;color:white}
.features{display:flex;justify-content:center;gap:30px;margin-top:60px;flex-wrap:wrap}
.feature-card{background:white;padding:30px;border-radius:20px;width:280px;text-align:center;box-shadow:0 4px 12px rgba(0,0,0,0.05)}
.feature-card h3{margin:15px 0 10px}
footer{margin-top:80px;text-align:center;padding:20px;border-top:1px solid #e2e8f0;color:#64748b}
</style>
</head>
<body>
<div class=container>
<header>
<div class=logo><img src="/logo.png" alt="BirMillat logosu" onerror="this.style.display='none'"> BirMillat</div>
<div class=nav-buttons><a href=/login>Kirish</a><a href=/register>Ro'yxatdan o'tish</a></div>
</header>
<div class=hero>
<h1>Qiziqishlaringiz bilan insonlarni toping</h1>
<p>BirMillat – bir fikr, bir maqsad, bir millat.</p>
<a href=/register class=btn>Boshlash ?</a>
<a href=/login class="btn btn-outline">Kirish</a>
</div>
<div class=features>
<div class=feature-card>??<h3>Moslashtirish</h3><p>Qiziqishlaringiz bo'yicha odamlarni toping</p></div>
<div class=feature-card>??<h3>Jonli suhbat</h3><p>Do'stlar so'rovi va bloklash</p></div>
<div class=feature-card>???<h3>Maxfiylik</h3><p>Siz kimni bloklasangiz, u sizga yozolmaydi</p></div>
</div>
<footer>© 2026 BirMillat – Barcha huquqlar himoyalangan</footer>
</div>
</body>
</html>`);
});

// ========== REGISTRATION ==========
app.get('/register', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Ro'yxatdan o'tish - BirMillat</title><style>
body{font-family:sans-serif;background:#f5f7fa;display:flex;justify-content:center;align-items:center;height:100vh}
.card{background:white;border-radius:20px;padding:40px;width:350px;text-align:center;box-shadow:0 4px 12px rgba(0,0,0,0.1)}
input{width:100%;padding:12px;margin:10px 0;border-radius:8px;border:1px solid #ddd}
button{background:#c0392b;color:white;border:none;padding:12px;width:100%;border-radius:8px;cursor:pointer}
.error{color:red}
a{color:#c0392b}
</style></head>
<body><div class=card><h2>Hisob yaratish</h2>
<form method=post action=/register id=regForm><input name=username placeholder="Foydalanuvchi nomi" required><input type=password name=password id=password placeholder="Parol (kamida 8 belgi)" required><div id=pwdError class=error></div><button type=submit>Ro'yxatdan o'tish</button></form>
<p>Hisobingiz bormi? <a href=/login>Kirish</a></p></div>
<script>document.getElementById('regForm').addEventListener('submit',function(e){if(document.getElementById('password').value.length<8){e.preventDefault();document.getElementById('pwdError').innerText='Parol kamida 8 belgi bo\'lishi kerak'}});</script>
</body></html>`);
});

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (password.length < 8) return res.send('Parol juda qisqa. <a href=/register>Orqaga</a>');
    getUser(username, async (err, row) => {
        if (row) return res.send('Bunday foydalanuvchi mavjud. <a href=/register>Orqaga</a>');
        const hashed = await bcrypt.hash(password, 10);
        createUser(username, hashed, (err) => {
            if (err) return res.send('Xatolik yuz berdi. <a href=/register>Qaytaring</a>');
            res.send('Muvaffaqiyatli ro\'yxatdan o\'tdingiz! <a href=/login>Kirish</a>');
        });
    });
});

// ========== LOGIN ==========
app.get('/login', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Kirish - BirMillat</title><style>
body{font-family:sans-serif;background:#f5f7fa;display:flex;justify-content:center;align-items:center;height:100vh}
.card{background:white;border-radius:20px;padding:40px;width:350px;text-align:center;box-shadow:0 4px 12px rgba(0,0,0,0.1)}
input{width:100%;padding:12px;margin:10px 0;border-radius:8px;border:1px solid #ddd}
button{background:#c0392b;color:white;border:none;padding:12px;width:100%;border-radius:8px;cursor:pointer}
a{color:#c0392b}
</style></head>
<body><div class=card><h2>Xush kelibsiz</h2>
<form method=post action=/login><input name=username placeholder="Foydalanuvchi nomi" required><input type=password name=password placeholder="Parol" required><button type=submit>Kirish</button></form>
<p>Hisobingiz yo'q? <a href=/register>Ro'yxatdan o'tish</a></p></div></body></html>`);
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    getUser(username, async (err, user) => {
        if (!user) return res.send('Foydalanuvchi topilmadi. <a href=/login>Qaytaring</a>');
        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.send('Parol xato. <a href=/login>Qaytaring</a>');
        req.session.userId = username;
        res.redirect('/home');
    });
});

// ========== HOME PAGE (after login) ==========
app.get('/home', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'home.html'));
});

// ========== CHAT PAGE ==========
app.get('/chat', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'chat.html'));
});

// ========== API ENDPOINTS ==========
app.get('/api/me', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Ruxsat yo\'q' });
    res.json({ username: req.session.userId });
});

app.get('/api/social', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Ruxsat yo\'q' });
    getUser(req.session.userId, (err, user) => {
        if (err || !user) return res.status(500).json({ error: 'Xatolik' });
        res.json({
            friends: JSON.parse(user.friends || '[]'),
            friendRequests: JSON.parse(user.friendRequests || '[]'),
            blocked: JSON.parse(user.blocked || '[]')
        });
    });
});

app.post('/api/friend-request', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Ruxsat yo\'q' });
    const { to } = req.body;
    const from = req.session.userId;
    getUser(to, (err, targetUser) => {
        if (!targetUser) return res.json({ error: 'Foydalanuvchi topilmadi' });
        let requests = JSON.parse(targetUser.friendRequests || '[]');
        if (requests.includes(from)) return res.json({ error: 'So\'rov allaqachon yuborilgan' });
        requests.push(from);
        updateUserSocial(to, 'friendRequests', requests, () => {
            res.json({ success: true });
        });
    });
});

app.post('/api/accept-request', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Ruxsat yo\'q' });
    const { from } = req.body;
    const to = req.session.userId;
    getUser(to, (err, user) => {
        if (!user) return res.json({ error: 'Xatolik' });
        let requests = JSON.parse(user.friendRequests || '[]');
        if (!requests.includes(from)) return res.json({ error: 'So\'rov mavjud emas' });
        requests = requests.filter(f => f !== from);
        let friends = JSON.parse(user.friends || '[]');
        if (!friends.includes(from)) friends.push(from);
        updateUserSocial(to, 'friendRequests', requests, () => {
            updateUserSocial(to, 'friends', friends, () => {
                getUser(from, (err, friendUser) => {
                    if (friendUser) {
                        let friendFriends = JSON.parse(friendUser.friends || '[]');
                        if (!friendFriends.includes(to)) friendFriends.push(to);
                        updateUserSocial(from, 'friends', friendFriends, () => {
                            res.json({ success: true });
                        });
                    } else {
                        res.json({ success: true });
                    }
                });
            });
        });
    });
});

app.post('/api/block', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Ruxsat yo\'q' });
    const { blockUser } = req.body;
    const current = req.session.userId;
    if (current === blockUser) return res.json({ error: 'O\'z-o\'zini bloklab bo\'lmaydi' });
    getUser(blockUser, (err, target) => {
        if (!target) return res.json({ error: 'Foydalanuvchi topilmadi' });
        getUser(current, (err, curUser) => {
            let blocked = JSON.parse(curUser.blocked || '[]');
            if (!blocked.includes(blockUser)) blocked.push(blockUser);
            let friends = JSON.parse(curUser.friends || '[]');
            friends = friends.filter(f => f !== blockUser);
            updateUserSocial(current, 'blocked', blocked, () => {
                updateUserSocial(current, 'friends', friends, () => {
                    getUser(blockUser, (err, blockUserData) => {
                        let targetFriends = JSON.parse(blockUserData.friends || '[]');
                        targetFriends = targetFriends.filter(f => f !== current);
                        updateUserSocial(blockUser, 'friends', targetFriends, () => {
                            res.json({ success: true });
                        });
                    });
                });
            });
        });
    });
});

app.get('/api/users', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Ruxsat yo\'q' });
    db.all('SELECT username FROM users', [], (err, rows) => {
        if (err) return res.status(500).json([]);
        const all = rows.map(r => r.username).filter(u => u !== req.session.userId);
        res.json(all);
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// ---------- SOCKET.IO (global chat with block respect) ----------
io.on('connection', (socket) => {
    const userId = socket.request.session.userId;
    if (!userId) {
        socket.disconnect();
        return;
    }
    socket.username = userId;

    socket.on('chat message', (msg) => {
        // Broadcast to all connected users except those who have blocked the sender
        for (let [id, clientSocket] of io.sockets.sockets) {
            const targetUser = clientSocket.username;
            if (targetUser) {
                getUser(targetUser, (err, user) => {
                    if (user && !JSON.parse(user.blocked || '[]').includes(userId)) {
                        clientSocket.emit('chat message', { user: socket.username, text: msg });
                    }
                });
            }
        }
    });

    socket.on('disconnect', () => {
        // optional: log
    });
});

// ---------- START SERVER ----------
server.listen(3000, () => console.log('Server ishga tushdi: http://localhost:3000'));