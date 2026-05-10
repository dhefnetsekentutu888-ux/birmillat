const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const server = http.createServer(app);

// ---------- Better-SQLite3 Database ----------
const db = new Database('./database.sqlite');
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        friends TEXT DEFAULT '[]',
        friendRequests TEXT DEFAULT '[]',
        blocked TEXT DEFAULT '[]',
        name TEXT,
        bio TEXT,
        interests TEXT DEFAULT '[]'
    )
`);

function getUser(username) {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}
function createUser(username, passwordHash) {
    return db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(username, passwordHash);
}
function updateUserSocial(username, field, value) {
    return db.prepare(`UPDATE users SET ${field} = ? WHERE username = ?`).run(JSON.stringify(value), username);
}

// ---------- Session Middleware ----------
const sessionMiddleware = session({
    secret: 'birMillat-secret-key-change-in-production',
    resave: false,
    saveUninitialized: false,
    store: new SQLiteStore({ db: 'sessions.sqlite', dir: './' }),
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
});

app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname)));

// ---------- Socket.IO with session support ----------
const io = new Server(server);
io.use((socket, next) => {
    cookieParser()(socket.request, socket.request.res || {}, (err) => {
        if (err) return next(err);
        sessionMiddleware(socket.request, socket.request.res || {}, next);
    });
});

// ========== PUBLIC HOME PAGE (unchanged) ==========
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html>
<head><title>BirMillat – Yoshlarni birlashtiruvchi aqlli platforma</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',sans-serif;background:#f5f7fa;color:#2c3e50}
.container{max-width:1200px;margin:0 auto;padding:20px}
header{display:flex;justify-content:space-between;align-items:center;padding:20px 0;flex-wrap:wrap}
.logo{font-size:28px;font-weight:bold;display:flex;align-items:center;gap:10px}
.logo img{height:40px}
.nav-buttons a{color:#2c3e50;text-decoration:none;background:#e2e8f0;padding:10px 20px;border-radius:30px;margin-left:10px;transition:0.3s}
.nav-buttons a:hover{background:#cbd5e1}
.hero{text-align:center;padding:60px 20px}
.hero h1{font-size:48px;margin-bottom:20px;color:#c0392b}
.hero p{font-size:20px;margin-bottom:30px;max-width:800px;margin-left:auto;margin-right:auto}
.btn{background:#c0392b;color:white;padding:12px 30px;border-radius:40px;text-decoration:none;display:inline-block;margin:10px;transition:0.3s}
.btn:hover{background:#a93226}
.btn-outline{background:transparent;border:2px solid #c0392b;color:#c0392b}
.btn-outline:hover{background:#c0392b;color:white}
.categories{text-align:center;margin:60px 0}
.categories h2{font-size:32px;margin-bottom:30px;color:#2c3e50}
.cat-grid{display:flex;justify-content:center;gap:25px;flex-wrap:wrap}
.cat-card{background:white;padding:25px;border-radius:20px;width:220px;box-shadow:0 4px 12px rgba(0,0,0,0.05);transition:transform 0.2s}
.cat-card:hover{transform:translateY(-5px)}
.cat-card i{font-size:40px;color:#c0392b;margin-bottom:15px}
.cat-card h3{margin-bottom:10px}
.mission{background:white;padding:40px;border-radius:20px;text-align:center;margin:40px 0;box-shadow:0 4px 12px rgba(0,0,0,0.05)}
.mission h2{color:#c0392b;margin-bottom:20px}
.mission p{font-size:18px;max-width:800px;margin:0 auto}
.social{text-align:center;margin:40px 0}
.social h3{margin-bottom:20px}
.social-icons{display:flex;justify-content:center;gap:30px}
.social-icons a{color:#2c3e50;font-size:36px;transition:0.3s}
.social-icons a:hover{color:#c0392b}
footer{margin-top:60px;text-align:center;padding:20px;border-top:1px solid #e2e8f0;color:#64748b}
@media (max-width:768px){.hero h1{font-size:32px}}
</style>
</head>
<body>
<div class=container>
<header>
<div class=logo><img src="/logo.png" alt="BirMillat logosu" onerror="this.style.display='none'"> BirMillat</div>
<div class=nav-buttons><a href=/login>Kirish</a><a href=/register>Ro'yxatdan o'tish</a></div>
</header>
<div class=hero>
<h1>Yoshlarni birlashtiruvchi aqlli platforma</h1>
<p>BirMillat — bu maqsadli, rivojlanishga intiluvchi yoshlarni bir joyga jamlaydigan zamonaviy platforma. Sun’iy intellekt yordamida foydalanuvchilarga o‘ziga o‘xshash fikrlaydigan, bir xil maqsad va qiziqishlarga ega insonlarni topishga yordam beradi.</p>
<a href=/register class=btn>Boshlash →</a>
<a href=/login class="btn btn-outline">Kirish</a>
</div>

<div class=categories>
<h2>📚 Kategoriyalar</h2>
<div class=cat-grid>
<div class=cat-card><i class="fas fa-graduation-cap"></i><h3>Ta’lim</h3><p>IELTS, CEFR, SAT, matematika, dasturlash</p></div>
<div class=cat-card><i class="fas fa-rocket"></i><h3>Startup va Loyihalar</h3><p>Yangi g‘oyalar, jamoa yig‘ish</p></div>
<div class=cat-card><i class="fas fa-hands-helping"></i><h3>Volontyorlik</h3><p>Ijtimoiy foydali tadbirlar</p></div>
<div class=cat-card><i class="fas fa-laptop-code"></i><h3>Texnologiya</h3><p>IT, AI, dizayn</p></div>
<div class=cat-card><i class="fas fa-trophy"></i><h3>Motivatsiya va Rivojlanish</h3><p>Maqsadli hamjamiyat</p></div>
</div>
</div>

<div class=mission>
<h2>🌟 BirMillat maqsadi</h2>
<p>Bugungi kunda ko‘plab yoshlar o‘ziga mos muhit va motivatsion insonlarni topishda qiynaladi. BirMillat esa yoshlarni birlashtirib, ularga rivojlanish, hamkorlik va katta maqsadlar sari birga harakat qilish imkonini beradi.</p>
<p style="margin-top:20px; font-style:italic">“Biz odamlarni emas, maqsadlarni birlashtiramiz.”</p>
</div>

<div class=social>
<h3>Bizni ijtimoiy tarmoqlarda kuzating</h3>
<div class=social-icons>
<a href="https://t.me/birmillatUZB" target="_blank"><i class="fab fa-telegram"></i></a>
<a href="https://www.instagram.com/birmillat.uz?igsh=OG05MXpkOWs4N2Zj&utm_source=qr" target="_blank"><i class="fab fa-instagram"></i></a>
</div>
</div>

<footer>© 2026 BirMillat – Barcha huquqlar himoyalangan</footer>
</div>
</body>
</html>`);
});

// ========== REGISTRATION ==========
function renderRegisterPage(message, isError = true) {
    const messageHtml = message ? `<div class="${isError ? 'error' : 'success'}">${message}</div>` : '';
    return `<!DOCTYPE html><html><head><title>Ro'yxatdan o'tish - BirMillat</title><style>
body{font-family:sans-serif;background:#f5f7fa;display:flex;justify-content:center;align-items:center;height:100vh}
.card{background:white;border-radius:20px;padding:40px;width:350px;text-align:center;box-shadow:0 4px 12px rgba(0,0,0,0.1)}
.logo-img{height:50px;margin-bottom:10px}
input{width:100%;padding:12px;margin:10px 0;border-radius:8px;border:1px solid #ddd}
button{background:#c0392b;color:white;border:none;padding:12px;width:100%;border-radius:8px;cursor:pointer}
.error{background:#ffe6e6;color:#c0392b;padding:8px;border-radius:6px;margin-bottom:15px;font-size:14px}
.success{background:#e6ffe6;color:#2e7d32;padding:8px;border-radius:6px;margin-bottom:15px;font-size:14px}
a{color:#c0392b}
</style></head>
<body>
<div class=card>
<img src="/logo.png" alt="BirMillat logosu" class="logo-img" onerror="this.style.display='none'">
<h2>Hisob yaratish</h2>
${messageHtml}
<form method=post action=/register id=regForm>
<input name=username placeholder="Foydalanuvchi nomi" required>
<input type=password name=password id=password placeholder="Parol (kamida 8 belgi)" required>
<div id=pwdError class="error" style="display:none"></div>
<button type=submit>Ro'yxatdan o'tish</button>
</form>
<p>Hisobingiz bormi? <a href=/login>Kirish</a></p>
</div>
<script>
document.getElementById('regForm').addEventListener('submit',function(e){
    const pwd = document.getElementById('password').value;
    if(pwd.length<8){
        e.preventDefault();
        const errDiv = document.getElementById('pwdError');
        errDiv.innerText = 'Parol kamida 8 belgi bo\'lishi kerak';
        errDiv.style.display = 'block';
    }
});
</script>
</body></html>`;
}

app.get('/register', (req, res) => {
    res.send(renderRegisterPage('', false));
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
    res.send(renderRegisterPage('Muvaffaqiyatli ro‘yxatdan o‘tdingiz! Endi <a href="/login">kirishingiz</a> mumkin.', false));
});

app.get('/login', (req, res) => {
    const error = req.query.error;
    let errorText = '';
    if (error === 'notfound') errorText = '❌ Login noto‘g‘ri kiritilgan';
    if (error === 'wrongpassword') errorText = '❌ Parol mos kelmadi';
    res.send(`<!DOCTYPE html><html><head><title>Kirish - BirMillat</title><style>
body{font-family:sans-serif;background:#f5f7fa;display:flex;justify-content:center;align-items:center;height:100vh}
.card{background:white;border-radius:20px;padding:40px;width:350px;text-align:center;box-shadow:0 4px 12px rgba(0,0,0,0.1)}
.logo-img{height:50px;margin-bottom:10px}
input{width:100%;padding:12px;margin:10px 0;border-radius:8px;border:1px solid #ddd}
button{background:#c0392b;color:white;border:none;padding:12px;width:100%;border-radius:8px;cursor:pointer}
.error{background:#ffe6e6;color:#c0392b;padding:8px;border-radius:6px;margin-bottom:15px;font-size:14px}
a{color:#c0392b}
</style></head>
<body>
<div class=card>
<img src="/logo.png" alt="BirMillat logosu" class="logo-img" onerror="this.style.display='none'">
<h2>Xush kelibsiz</h2>
${errorText ? `<div class="error">${errorText}</div>` : ''}
<form method=post action=/login>
<input name=username placeholder="Foydalanuvchi nomi" required>
<input type=password name=password placeholder="Parol" required>
<button type=submit>Kirish</button>
</form>
<p>Hisobingiz yo'q? <a href=/register>Ro'yxatdan o'tish</a></p>
</div></body></html>`);
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = getUser(username);
    if (!user) return res.redirect('/login?error=notfound');
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.redirect('/login?error=wrongpassword');
    req.session.userId = username;
    res.redirect('/home');
});

// ========== HOME & CHAT ==========
app.get('/home', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'home.html'));
});

app.get('/chat', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'chat.html'));
});

// ========== PROFILE & SEARCH APIs ==========
app.get('/api/me', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    res.json({ username: req.session.userId });
});

app.get('/api/profile/:username', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    const target = req.params.username;
    const user = getUser(target);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
        username: user.username,
        name: user.name || user.username,
        bio: user.bio || '',
        interests: JSON.parse(user.interests || '[]')
    });
});

app.post('/api/profile/update', express.json(), (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    const { name, bio, interests } = req.body;
    const user = getUser(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    db.prepare(`UPDATE users SET name = ?, bio = ?, interests = ? WHERE username = ?`)
        .run(name || req.session.userId, bio || '', JSON.stringify(interests || []), req.session.userId);
    res.json({ success: true });
});

app.get('/api/search', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    const q = req.query.q || '';
    const usersList = db.prepare(`SELECT username, name, interests FROM users WHERE username LIKE ? OR name LIKE ?`).all(`%${q}%`, `%${q}%`);
    res.json(usersList.filter(u => u.username !== req.session.userId));
});

// ========== SOCIAL APIS (friend requests, block, users list) ==========
app.get('/api/social', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    const user = getUser(req.session.userId);
    res.json({
        friends: JSON.parse(user.friends || '[]'),
        friendRequests: JSON.parse(user.friendRequests || '[]'),
        blocked: JSON.parse(user.blocked || '[]')
    });
});

app.post('/api/friend-request', express.json(), (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    const { to } = req.body;
    const from = req.session.userId;
    const target = getUser(to);
    if (!target) return res.json({ error: 'Foydalanuvchi topilmadi' });
    let requests = JSON.parse(target.friendRequests || '[]');
    if (requests.includes(from)) return res.json({ error: 'So‘rov allaqachon yuborilgan' });
    requests.push(from);
    updateUserSocial(to, 'friendRequests', requests);
    res.json({ success: true });
});

app.post('/api/accept-request', express.json(), (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    const { from } = req.body;
    const to = req.session.userId;
    const user = getUser(to);
    let requests = JSON.parse(user.friendRequests || '[]');
    if (!requests.includes(from)) return res.json({ error: 'So‘rov mavjud emas' });
    requests = requests.filter(f => f !== from);
    let friends = JSON.parse(user.friends || '[]');
    if (!friends.includes(from)) friends.push(from);
    updateUserSocial(to, 'friendRequests', requests);
    updateUserSocial(to, 'friends', friends);
    const friendUser = getUser(from);
    let friendFriends = JSON.parse(friendUser.friends || '[]');
    if (!friendFriends.includes(to)) friendFriends.push(to);
    updateUserSocial(from, 'friends', friendFriends);
    res.json({ success: true });
});

app.post('/api/block', express.json(), (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    const { blockUser } = req.body;
    const current = req.session.userId;
    if (current === blockUser) return res.json({ error: 'O‘z-o‘zini bloklab bo‘lmaydi' });
    const target = getUser(blockUser);
    if (!target) return res.json({ error: 'Foydalanuvchi topilmadi' });
    let blocked = JSON.parse(getUser(current).blocked || '[]');
    if (!blocked.includes(blockUser)) blocked.push(blockUser);
    let friends = JSON.parse(getUser(current).friends || '[]');
    friends = friends.filter(f => f !== blockUser);
    updateUserSocial(current, 'blocked', blocked);
    updateUserSocial(current, 'friends', friends);
    const blockedUserData = getUser(blockUser);
    let targetFriends = JSON.parse(blockedUserData.friends || '[]');
    targetFriends = targetFriends.filter(f => f !== current);
    updateUserSocial(blockUser, 'friends', targetFriends);
    res.json({ success: true });
});

app.get('/api/users', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    const rows = db.prepare('SELECT username FROM users').all();
    const all = rows.map(r => r.username).filter(u => u !== req.session.userId);
    res.json(all);
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// ---------- SOCKET.IO (global chat with colored messages) ----------
io.on('connection', (socket) => {
    const userId = socket.request.session.userId;
    if (!userId) {
        socket.disconnect();
        return;
    }
    socket.username = userId;

    socket.on('global message', (msg) => {
        const messageObj = {
            user: socket.username,
            text: msg,
            timestamp: Date.now()
        };
        io.emit('global message', messageObj);
    });
});

// ---------- START SERVER ----------
server.listen(3000, () => console.log('Server ishga tushdi: http://localhost:3000'));
