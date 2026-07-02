const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const http = require('http');
const { Server: SocketIOServer } = require('socket.io');
const { createClient } = require('@libsql/client');
const multer = require('multer');

const app = express();
const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer);
const PORT = process.env.PORT || 3000;

// In-memory storage is fine here — screenshots are forwarded straight to
// Telegram and never written to disk or the database.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // Telegram's own sendPhoto limit is 10MB
});

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

    // Add email + verification columns for existing databases that predate this feature.
    // ALTER TABLE ADD COLUMN can't add UNIQUE directly, so uniqueness is enforced
    // separately below via a unique index (which allows multiple NULLs, so old
    // accounts without an email yet don't conflict with each other).
    try { await db.execute(`ALTER TABLE users ADD COLUMN email TEXT`); } catch (e) {}
    try { await db.execute(`ALTER TABLE users ADD COLUMN is_verified INTEGER DEFAULT 0`); } catch (e) {}
    await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (email)`);

    // Profile enrichment: photo, birthdate (age is calculated from this, not stored directly), region
    try { await db.execute(`ALTER TABLE users ADD COLUMN photo_url TEXT`); } catch (e) {}
    try { await db.execute(`ALTER TABLE users ADD COLUMN birthdate TEXT`); } catch (e) {}
    try { await db.execute(`ALTER TABLE users ADD COLUMN region TEXT`); } catch (e) {}

    // Moderation: block/unblock via Telegram bot admin command
    try { await db.execute(`ALTER TABLE users ADD COLUMN is_blocked INTEGER DEFAULT 0`); } catch (e) {}

    // Two-way support chat: tracks every message in either direction so an
    // admin reply (via Telegram's native Reply feature) can be routed back
    // to the correct user, whether they reached out via Telegram or the website.
    await db.execute(`
        CREATE TABLE IF NOT EXISTS support_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            telegram_chat_id TEXT NOT NULL,
            website_username TEXT,
            direction TEXT NOT NULL,
            content TEXT,
            admin_message_id TEXT,
            created_at INTEGER NOT NULL
        )
    `);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_support_admin_msg ON support_messages (admin_message_id)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_support_chat ON support_messages (telegram_chat_id)`);

    // Profile achievements/certificates — title + image always shown, description/date optional and revealed on click
    await db.execute(`
        CREATE TABLE IF NOT EXISTS achievements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            image_url TEXT NOT NULL,
            description TEXT,
            achieved_date TEXT,
            created_at INTEGER NOT NULL
        )
    `);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_achievements_user ON achievements (user_id)`);

    // Communities — open group chats, anyone can create/join, creator can remove members
    await db.execute(`
        CREATE TABLE IF NOT EXISTS communities (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            description TEXT,
            category TEXT,
            creator_id INTEGER NOT NULL,
            created_at INTEGER NOT NULL
        )
    `);
    try { await db.execute(`ALTER TABLE communities ADD COLUMN image_url TEXT`); } catch (e) {}

    await db.execute(`
        CREATE TABLE IF NOT EXISTS community_members (
            community_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            joined_at INTEGER NOT NULL,
            role TEXT NOT NULL DEFAULT 'member',
            PRIMARY KEY (community_id, user_id)
        )
    `);
    try { await db.execute(`ALTER TABLE community_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member'`); } catch (e) {}

    await db.execute(`
        CREATE TABLE IF NOT EXISTS community_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            community_id INTEGER NOT NULL,
            sender_id INTEGER NOT NULL,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            reply_to_id INTEGER
        )
    `);
    try { await db.execute(`ALTER TABLE community_messages ADD COLUMN reply_to_id INTEGER`); } catch (e) {}
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_community_messages ON community_messages (community_id, created_at)`);

    // Email verification codes (used at registration and for password reset)
    await db.execute(`
        CREATE TABLE IF NOT EXISTS verification_codes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL,
            code TEXT NOT NULL,
            purpose TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            used INTEGER DEFAULT 0,
            created_at INTEGER NOT NULL
        )
    `);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_verification_email ON verification_codes (email, purpose)`);

    // Pending registrations: holds username/password while an email verification
    // code is outstanding. The real `users` row is only created once the code is
    // confirmed — this is what stops half-finished signups from permanently
    // occupying a username/email if the person never receives or enters the code.
    await db.execute(`
        CREATE TABLE IF NOT EXISTS pending_registrations (
            email TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )
    `);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_pending_username ON pending_registrations (username)`);

    // Community events — submitted by users, require approval before going public
    await db.execute(`
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            creator_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            category TEXT,
            mode TEXT NOT NULL DEFAULT 'in_person',
            location TEXT,
            event_date INTEGER NOT NULL,
            capacity INTEGER,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at INTEGER NOT NULL
        )
    `);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_events_status ON events (status, event_date)`);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS event_attendees (
            event_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            joined_at INTEGER NOT NULL,
            PRIMARY KEY (event_id, user_id)
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

async function getUserByEmail(email) {
    const result = await db.execute({
        sql: 'SELECT * FROM users WHERE email = ?',
        args: [email]
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

async function createUser(username, email, passwordHash, isVerified = 0) {
    const result = await db.execute({
        sql: 'INSERT INTO users (username, email, password, name, is_verified) VALUES (?, ?, ?, ?, ?)',
        args: [username, email, passwordHash, username, isVerified]
    });
    return Number(result.lastInsertRowid);
}

async function markUserVerified(email) {
    return db.execute({
        sql: 'UPDATE users SET is_verified = 1 WHERE email = ?',
        args: [email]
    });
}

async function updateUserPassword(email, passwordHash) {
    return db.execute({
        sql: 'UPDATE users SET password = ? WHERE email = ?',
        args: [passwordHash, email]
    });
}

function generateSixDigitCode() {
    return String(Math.floor(100000 + Math.random() * 900000));
}

async function createVerificationCode(email, purpose) {
    const code = generateSixDigitCode();
    const now = Date.now();
    const expiresAt = now + 15 * 60 * 1000; // 15 minutes
    await db.execute({
        sql: `INSERT INTO verification_codes (email, code, purpose, expires_at, used, created_at)
              VALUES (?, ?, ?, ?, 0, ?)`,
        args: [email, code, purpose, expiresAt, now]
    });
    return code;
}

async function verifyCode(email, code, purpose) {
    const result = await db.execute({
        sql: `SELECT * FROM verification_codes
              WHERE email = ? AND code = ? AND purpose = ? AND used = 0
              ORDER BY created_at DESC LIMIT 1`,
        args: [email, code, purpose]
    });
    const row = result.rows[0];
    if (!row) return { valid: false, reason: 'Kod noto‘g‘ri' };
    if (row.expires_at < Date.now()) return { valid: false, reason: 'Kod muddati tugagan' };

    await db.execute({ sql: 'UPDATE verification_codes SET used = 1 WHERE id = ?', args: [row.id] });
    return { valid: true };
}

// ---------- Pending registration helpers ----------
// A pending registration reserves a username/email + hashed password while a
// verification code is outstanding. It expires after 30 minutes: past that, it
// no longer blocks the username/email from being used by someone else, and a
// stale code tied to it simply won't verify (verifyCode already checks expiry
// on the code itself too).
const PENDING_REGISTRATION_TTL_MS = 30 * 60 * 1000;

async function createPendingRegistration(email, username, passwordHash) {
    const now = Date.now();
    await db.execute({
        sql: `INSERT INTO pending_registrations (email, username, password_hash, created_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(email) DO UPDATE SET username = excluded.username, password_hash = excluded.password_hash, created_at = excluded.created_at`,
        args: [email, username, passwordHash, now]
    });
}

async function getPendingRegistration(email) {
    const result = await db.execute({ sql: 'SELECT * FROM pending_registrations WHERE email = ?', args: [email] });
    const row = result.rows[0];
    if (!row) return null;
    if (Date.now() - row.created_at > PENDING_REGISTRATION_TTL_MS) return null; // treat as expired
    return row;
}

async function deletePendingRegistration(email) {
    return db.execute({ sql: 'DELETE FROM pending_registrations WHERE email = ?', args: [email] });
}

// Username is considered taken if a real account has it, OR if someone else has
// a *fresh* (non-expired) pending registration holding it.
async function isUsernameTaken(username, excludeEmail = null) {
    const existing = await getUser(username);
    if (existing) return true;

    const result = await db.execute({ sql: 'SELECT email, created_at FROM pending_registrations WHERE username = ?', args: [username] });
    for (const row of result.rows) {
        if (excludeEmail && row.email === excludeEmail) continue; // a person re-submitting their own pending signup is fine
        if (Date.now() - row.created_at <= PENDING_REGISTRATION_TTL_MS) return true;
    }
    return false;
}

async function updateUserProfile(username, { name, bio, interests, birthdate, region }) {
    return db.execute({
        sql: `UPDATE users SET name = ?, bio = ?, interests = ?, birthdate = ?, region = ? WHERE username = ?`,
        args: [name, bio, JSON.stringify(interests), birthdate || null, region || null, username]
    });
}

async function updateUserPhoto(userId, photoUrl) {
    return db.execute({
        sql: 'UPDATE users SET photo_url = ? WHERE id = ?',
        args: [photoUrl, userId]
    });
}

async function setUserBlocked(username, blocked) {
    const result = await db.execute({
        sql: 'UPDATE users SET is_blocked = ? WHERE username = ?',
        args: [blocked ? 1 : 0, username]
    });

    if (blocked && result.rowsAffected > 0) {
        // Destroy any active session(s) for this user so the block takes
        // effect immediately, not just the next time they try to log in.
        // Sessions store userId inside a JSON blob, so we scan rather than
        // query it directly — sessions tables are small enough that this is fine.
        const user = await getUser(username);
        if (user) {
            const sessions = await db.execute('SELECT sid, sess FROM sessions');
            for (const row of sessions.rows) {
                try {
                    const parsed = JSON.parse(row.sess);
                    if (parsed.userId === user.id) {
                        await db.execute({ sql: 'DELETE FROM sessions WHERE sid = ?', args: [row.sid] });
                    }
                } catch (e) { /* skip malformed session rows */ }
            }
        }
    }

    return result.rowsAffected > 0;
}

// ---------- Support chat helpers ----------
async function recordSupportMessage({ telegramChatId, websiteUsername, direction, content, adminMessageId }) {
    const result = await db.execute({
        sql: `INSERT INTO support_messages (telegram_chat_id, website_username, direction, content, admin_message_id, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [telegramChatId, websiteUsername || null, direction, content || null, adminMessageId || null, Date.now()]
    });
    return Number(result.lastInsertRowid);
}

async function findSupportThreadByAdminMessageId(adminMessageId) {
    const result = await db.execute({
        sql: `SELECT * FROM support_messages WHERE admin_message_id = ? ORDER BY created_at DESC LIMIT 1`,
        args: [String(adminMessageId)]
    });
    return result.rows[0] || null;
}

function calculateAge(birthdateStr) {
    if (!birthdateStr) return null;
    const birth = new Date(birthdateStr);
    if (isNaN(birth.getTime())) return null;
    const now = new Date();
    let age = now.getFullYear() - birth.getFullYear();
    const monthDiff = now.getMonth() - birth.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < birth.getDate())) {
        age--;
    }
    return age;
}

async function getAllUsersExcept(username) {
    const result = await db.execute({
        sql: 'SELECT username, name, bio, interests, photo_url, birthdate, region FROM users WHERE username != ?',
        args: [username]
    });
    return result.rows;
}

async function searchUsers(currentUsername, query) {
    // Matches against username, name, and the raw interests JSON text (simple substring match)
    const likeQuery = `%${query}%`;
    const result = await db.execute({
        sql: `SELECT username, name, bio, interests, photo_url, birthdate, region FROM users
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
        sql: `SELECT username, name, bio, interests, photo_url, birthdate, region FROM users
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

// ---------- Events ----------
async function createEvent({ creatorId, title, description, category, mode, location, eventDate, capacity }) {
    const result = await db.execute({
        sql: `INSERT INTO events (creator_id, title, description, category, mode, location, event_date, capacity, status, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        args: [creatorId, title, description, category, mode, location, eventDate, capacity || null, Date.now()]
    });
    return Number(result.lastInsertRowid);
}

async function getEventById(id) {
    const result = await db.execute({
        sql: `SELECT events.*, users.username AS creator_username, users.name AS creator_name
              FROM events JOIN users ON users.id = events.creator_id
              WHERE events.id = ?`,
        args: [id]
    });
    return result.rows[0] || null;
}

async function getApprovedEvents(category) {
    const now = Date.now();
    if (category) {
        const result = await db.execute({
            sql: `SELECT events.*, users.username AS creator_username, users.name AS creator_name,
                         (SELECT COUNT(*) FROM event_attendees WHERE event_attendees.event_id = events.id) AS attendee_count
                  FROM events JOIN users ON users.id = events.creator_id
                  WHERE events.status = 'approved' AND events.event_date >= ? AND events.category = ?
                  ORDER BY events.event_date ASC`,
            args: [now, category]
        });
        return result.rows;
    }
    const result = await db.execute({
        sql: `SELECT events.*, users.username AS creator_username, users.name AS creator_name,
                     (SELECT COUNT(*) FROM event_attendees WHERE event_attendees.event_id = events.id) AS attendee_count
              FROM events JOIN users ON users.id = events.creator_id
              WHERE events.status = 'approved' AND events.event_date >= ?
              ORDER BY events.event_date ASC`,
        args: [now]
    });
    return result.rows;
}

async function setEventStatus(id, status) {
    return db.execute({ sql: 'UPDATE events SET status = ? WHERE id = ?', args: [status, id] });
}

async function joinEvent(eventId, userId) {
    return db.execute({
        sql: `INSERT OR IGNORE INTO event_attendees (event_id, user_id, joined_at) VALUES (?, ?, ?)`,
        args: [eventId, userId, Date.now()]
    });
}

async function leaveEvent(eventId, userId) {
    return db.execute({
        sql: `DELETE FROM event_attendees WHERE event_id = ? AND user_id = ?`,
        args: [eventId, userId]
    });
}

async function getEventAttendees(eventId) {
    const result = await db.execute({
        sql: `SELECT users.username, users.name FROM event_attendees
              JOIN users ON users.id = event_attendees.user_id
              WHERE event_attendees.event_id = ?
              ORDER BY event_attendees.joined_at ASC`,
        args: [eventId]
    });
    return result.rows;
}

async function isUserAttending(eventId, userId) {
    const result = await db.execute({
        sql: `SELECT 1 FROM event_attendees WHERE event_id = ? AND user_id = ?`,
        args: [eventId, userId]
    });
    return result.rows.length > 0;
}

// ---------- Achievements ----------
const MAX_ACHIEVEMENTS_PER_USER = 4;

async function getAchievementsByUserId(userId) {
    const result = await db.execute({
        sql: `SELECT * FROM achievements WHERE user_id = ? ORDER BY created_at ASC`,
        args: [userId]
    });
    return result.rows;
}

async function countAchievements(userId) {
    const result = await db.execute({
        sql: `SELECT COUNT(*) as count FROM achievements WHERE user_id = ?`,
        args: [userId]
    });
    return result.rows[0].count;
}

async function createAchievement(userId, { title, imageUrl, description, achievedDate }) {
    const result = await db.execute({
        sql: `INSERT INTO achievements (user_id, title, image_url, description, achieved_date, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [userId, title, imageUrl, description || null, achievedDate || null, Date.now()]
    });
    return Number(result.lastInsertRowid);
}

async function getAchievementById(id) {
    const result = await db.execute({ sql: 'SELECT * FROM achievements WHERE id = ?', args: [id] });
    return result.rows[0] || null;
}

async function deleteAchievement(id, userId) {
    // Scoped to userId so someone can't delete another user's achievement by guessing IDs.
    const result = await db.execute({
        sql: 'DELETE FROM achievements WHERE id = ? AND user_id = ?',
        args: [id, userId]
    });
    return result.rowsAffected > 0;
}

// ---------- Communities ----------
async function createCommunity(creatorId, { name, description, category, imageUrl }) {
    const now = Date.now();
    const result = await db.execute({
        sql: `INSERT INTO communities (name, description, category, creator_id, created_at, image_url) VALUES (?, ?, ?, ?, ?, ?)`,
        args: [name, description || null, category || 'Boshqa', creatorId, now, imageUrl || null]
    });
    const communityId = Number(result.lastInsertRowid);
    // Creator automatically joins their own community
    await db.execute({
        sql: `INSERT INTO community_members (community_id, user_id, joined_at) VALUES (?, ?, ?)`,
        args: [communityId, creatorId, now]
    });
    return communityId;
}

async function updateCommunityImage(communityId, imageUrl) {
    return db.execute({
        sql: 'UPDATE communities SET image_url = ? WHERE id = ?',
        args: [imageUrl, communityId]
    });
}

async function getCommunityById(id) {
    const result = await db.execute({
        sql: `SELECT communities.*, users.username AS creator_username
              FROM communities JOIN users ON users.id = communities.creator_id
              WHERE communities.id = ?`,
        args: [id]
    });
    return result.rows[0] || null;
}

async function listCommunities(category) {
    const sql = category
        ? `SELECT c.*, users.username AS creator_username,
                  (SELECT COUNT(*) FROM community_members WHERE community_id = c.id) AS member_count
           FROM communities c JOIN users ON users.id = c.creator_id
           WHERE c.category = ? ORDER BY c.created_at DESC`
        : `SELECT c.*, users.username AS creator_username,
                  (SELECT COUNT(*) FROM community_members WHERE community_id = c.id) AS member_count
           FROM communities c JOIN users ON users.id = c.creator_id
           ORDER BY c.created_at DESC`;
    const result = await db.execute(category ? { sql, args: [category] } : sql);
    return result.rows;
}

async function joinCommunity(communityId, userId) {
    return db.execute({
        sql: `INSERT OR IGNORE INTO community_members (community_id, user_id, joined_at) VALUES (?, ?, ?)`,
        args: [communityId, userId, Date.now()]
    });
}

async function leaveCommunity(communityId, userId) {
    return db.execute({
        sql: `DELETE FROM community_members WHERE community_id = ? AND user_id = ?`,
        args: [communityId, userId]
    });
}

async function removeCommunityMember(communityId, userId) {
    return db.execute({
        sql: `DELETE FROM community_members WHERE community_id = ? AND user_id = ?`,
        args: [communityId, userId]
    });
}

async function isCommunityMember(communityId, userId) {
    const result = await db.execute({
        sql: `SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?`,
        args: [communityId, userId]
    });
    return result.rows.length > 0;
}

async function getMemberRole(communityId, userId) {
    const result = await db.execute({
        sql: `SELECT role FROM community_members WHERE community_id = ? AND user_id = ?`,
        args: [communityId, userId]
    });
    return result.rows[0] ? result.rows[0].role : null;
}

async function isCommunityAdminOrCreator(communityId, userId, creatorId) {
    if (Number(userId) === Number(creatorId)) return true;
    const role = await getMemberRole(communityId, userId);
    return role === 'admin';
}

async function setMemberRole(communityId, userId, role) {
    const result = await db.execute({
        sql: `UPDATE community_members SET role = ? WHERE community_id = ? AND user_id = ?`,
        args: [role, communityId, userId]
    });
    return result.rowsAffected > 0;
}

async function getCommunityMembers(communityId) {
    const result = await db.execute({
        sql: `SELECT users.id, users.username, users.name, users.photo_url, community_members.role
              FROM community_members
              JOIN users ON users.id = community_members.user_id
              WHERE community_members.community_id = ?
              ORDER BY community_members.joined_at ASC`,
        args: [communityId]
    });
    return result.rows;
}

async function saveCommunityMessage(communityId, senderId, content, replyToId) {
    const createdAt = Date.now();
    const result = await db.execute({
        sql: `INSERT INTO community_messages (community_id, sender_id, content, created_at, reply_to_id) VALUES (?, ?, ?, ?, ?)`,
        args: [communityId, senderId, content, createdAt, replyToId || null]
    });
    return { id: Number(result.lastInsertRowid), createdAt };
}

async function getCommunityMessageById(id) {
    const result = await db.execute({
        sql: `SELECT community_messages.*, users.username, users.name
              FROM community_messages JOIN users ON users.id = community_messages.sender_id
              WHERE community_messages.id = ?`,
        args: [id]
    });
    return result.rows[0] || null;
}

async function getCommunityMessages(communityId, limit = 100) {
    const result = await db.execute({
        sql: `SELECT
                  m.*, users.username, users.name, users.photo_url,
                  reply.content AS reply_content,
                  reply_user.username AS reply_username,
                  reply_user.name AS reply_name
              FROM community_messages m
              JOIN users ON users.id = m.sender_id
              LEFT JOIN community_messages reply ON reply.id = m.reply_to_id
              LEFT JOIN users reply_user ON reply_user.id = reply.sender_id
              WHERE m.community_id = ?
              ORDER BY m.created_at ASC
              LIMIT ?`,
        args: [communityId, limit]
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
    <link rel="icon" type="image/png" href="/favicon.png">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/style.css">
    <style>
        .pw-field { position: relative; }
        .pw-field input { padding-right: 2.6rem !important; }
        .auth-card .pw-toggle {
            position: absolute; right: 0.4rem; top: 0.65rem;
            width: 2rem !important; height: 2rem;
            background: none !important; border: none; cursor: pointer; padding: 0.25rem !important;
            margin: 0 !important;
            color: var(--color-text-muted); display: flex; align-items: center; justify-content: center;
        }
        .auth-card .pw-toggle:hover { color: var(--color-text); background: none !important; }
        .field-error { color: var(--color-error); font-size: 0.8rem; text-align: left; margin: -0.3rem 0 0.6rem; min-height: 1em; }
        .auth-logo { height: 40px; margin-bottom: 1rem; }
        .field-hint { font-size: 0.78rem; color: var(--color-text-muted); text-align: left; margin: -0.3rem 0 0.6rem; }
    </style>
    </head>
    <body class="auth-shell"><div class="auth-card">
        <img src="/logo-full.svg" alt="BirMillat" class="auth-logo">
        <h2>Hisob yaratish</h2>
        ${message ? `<div class="message ${msgClass}">${message}</div>` : ''}
        <form method=post action=/register id="registerForm">
            <input type=email name=email placeholder="Email manzilingiz (ixtiyoriy)">
            <div class="field-hint">Email qoldirsangiz, hisobingizni tasdiqlash kodi yuboriladi. Qoldirmasangiz ham ro'yxatdan o'tishingiz mumkin.</div>
            <input name=username placeholder="Foydalanuvchi nomi" required>

            <div class="pw-field">
                <input type=password name=password id=password placeholder="Parol (kamida 8 belgi)" minlength=8 required>
                <button type="button" class="pw-toggle" data-target="password" aria-label="Parolni ko'rsatish">${eyeIconOpen()}</button>
            </div>

            <div class="pw-field">
                <input type=password name=confirmPassword id=confirmPassword placeholder="Parolni takrorlang" minlength=8 required>
                <button type="button" class="pw-toggle" data-target="confirmPassword" aria-label="Parolni ko'rsatish">${eyeIconOpen()}</button>
            </div>
            <div class="field-error" id="matchError"></div>

            <button type=submit>Ro'yxatdan o'tish</button>
        </form>
        <p>Hisobingiz bormi? <a href=/login>Kirish</a></p>
    </div>
    <script>${passwordToggleScript()}
        // Client-side confirm-password check (server also re-checks this)
        const form = document.getElementById('registerForm');
        const pw = document.getElementById('password');
        const confirmPw = document.getElementById('confirmPassword');
        const matchError = document.getElementById('matchError');
        form.addEventListener('submit', (e) => {
            if (pw.value !== confirmPw.value) {
                e.preventDefault();
                matchError.textContent = 'Parollar mos kelmadi';
            }
        });
        confirmPw.addEventListener('input', () => {
            matchError.textContent = (pw.value && confirmPw.value && pw.value !== confirmPw.value) ? 'Parollar mos kelmadi' : '';
        });
    </script>
    </body></html>`;
}

function renderLoginPage(message, isError = true, next = '/home') {
    const msgClass = isError ? 'error' : 'success';
    const safeNext = safeNextPath(next);
    return `<!DOCTYPE html><html><head><title>Kirish - BirMillat</title>
    <link rel="icon" type="image/png" href="/favicon.png">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/style.css">
    <style>
        .pw-field { position: relative; }
        .pw-field input { padding-right: 2.6rem !important; }
        .auth-card .pw-toggle {
            position: absolute; right: 0.4rem; top: 0.65rem;
            width: 2rem !important; height: 2rem;
            background: none !important; border: none; cursor: pointer; padding: 0.25rem !important;
            margin: 0 !important;
            color: var(--color-text-muted); display: flex; align-items: center; justify-content: center;
        }
        .auth-card .pw-toggle:hover { color: var(--color-text); background: none !important; }
        .auth-logo { height: 40px; margin-bottom: 1rem; }
    </style>
    </head>
    <body class="auth-shell"><div class="auth-card">
        <svg width="140" height="40" viewBox="0 0 320 90" xmlns="http://www.w3.org/2000/svg" class="auth-logo" style="height:40px; width:auto;">
          <g transform="translate(45,45)">
            <g transform="rotate(-18)"><ellipse cx="-10" cy="0" rx="20" ry="36" fill="none" stroke="#2D1B69" stroke-width="10"/></g>
            <g transform="rotate(18)"><ellipse cx="10" cy="0" rx="20" ry="36" fill="none" stroke="#FF6B5B" stroke-width="10"/></g>
            <g transform="rotate(-18)"><path d="M -30 0 A 20 36 0 0 1 11 0" fill="none" stroke="#2D1B69" stroke-width="10" stroke-linecap="round"/></g>
          </g>
          <text x="95" y="53" font-size="34" font-weight="700" fill="#2D1B69" font-family="Poppins, -apple-system, sans-serif">Bir<tspan fill="#FF6B5B">Millat</tspan></text>
        </svg>
        <h2>Xush kelibsiz</h2>
        ${message ? `<div class="message ${msgClass}">${message}</div>` : ''}
        <form method=post action=/login>
            <input type=hidden name=next value="${safeNext}">
            <input name=identifier placeholder="Email yoki foydalanuvchi nomi" required>
            <div class="pw-field">
                <input type=password name=password id=password placeholder="Parol" required>
                <button type="button" class="pw-toggle" data-target="password" aria-label="Parolni ko'rsatish">${eyeIconOpen()}</button>
            </div>
            <button type=submit>Kirish</button>
        </form>
        <p><a href=/forgot-password style="font-size:0.85rem;">Parolni unutdingizmi?</a></p>
        <p>Hisobingiz yo'q? <a href=/register>Ro'yxatdan o'tish</a></p>
    </div>
    <script>${passwordToggleScript()}</script>
    </body></html>`;
}

// ---------- Shared bits for password visibility toggle ----------
function eyeIconOpen() {
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
}

function eyeIconClosed() {
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
}

function passwordToggleScript() {
    // Toggles type=password/text on the matching input and swaps the icon.
    return `
        const eyeOpen = ${JSON.stringify(eyeIconOpen())};
        const eyeClosed = ${JSON.stringify(eyeIconClosed())};
        document.querySelectorAll('.pw-toggle').forEach(btn => {
            btn.addEventListener('click', () => {
                const input = document.getElementById(btn.getAttribute('data-target'));
                const showing = input.type === 'text';
                input.type = showing ? 'password' : 'text';
                btn.innerHTML = showing ? eyeOpen : eyeClosed;
            });
        });
    `;
}

// Routes
app.get('/', (req, res) => {
    if (req.session.userId) return res.redirect('/home');
    res.sendFile(path.join(__dirname, 'index.html'));
});

function safeNextPath(next) {
    // Only allow internal paths, never an absolute URL — prevents this becoming an open redirect.
    if (typeof next === 'string' && next.startsWith('/') && !next.startsWith('//')) {
        return next;
    }
    return '/home';
}

app.get('/login', (req, res) => {
    const next = safeNextPath(req.query.next);
    if (req.session.userId) return res.redirect(next);
    res.send(renderLoginPage('', true, next));
});

app.post('/login', async (req, res) => {
    try {
        const { identifier, password, next } = req.body;
        const safeNext = safeNextPath(next);
        const clean = (identifier || '').trim();
        const user = clean.includes('@')
            ? await getUserByEmail(clean.toLowerCase())
            : await getUser(clean);

        if (!user) return res.send(renderLoginPage('Login noto‘g‘ri', true, safeNext));
        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.send(renderLoginPage('Parol noto‘g‘ri', true, safeNext));

        if (user.is_blocked) {
            return res.send(renderLoginPage('🚫 Hisobingiz bloklangan. Savollar bo‘yicha <a href="/support">shu yerdan</a> murojaat qiling.', true, safeNext));
        }

        if (!user.is_verified && user.email) {
            return res.redirect(`/verify?email=${encodeURIComponent(user.email)}`);
        }

        req.session.userId = user.id;
        req.session.username = user.username;
        res.redirect(safeNext);
    } catch (err) {
        console.error('Login error:', err);
        res.send(renderLoginPage('Server xatosi, qaytadan urinib ko‘ring', true, safeNextPath(req.body.next)));
    }
});

app.get('/register', (req, res) => {
    if (req.session.userId) return res.redirect('/home');
    res.send(renderRegisterPage(''));
});

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

app.post('/register', async (req, res) => {
    try {
        const { username, email, password, confirmPassword } = req.body;
        const cleanUsername = (username || '').trim();
        const cleanEmail = (email || '').trim().toLowerCase();

        if (!cleanUsername || !password) {
            return res.send(renderRegisterPage('Foydalanuvchi nomi va parol kerak', true));
        }
        if (password.length < 8) {
            return res.send(renderRegisterPage('Parol kamida 8 belgi bo‘lishi kerak', true));
        }
        if (password !== confirmPassword) {
            return res.send(renderRegisterPage('Parollar mos kelmadi', true));
        }
        if (cleanEmail && !isValidEmail(cleanEmail)) {
            return res.send(renderRegisterPage('Email manzili noto‘g‘ri', true));
        }

        if (await isUsernameTaken(cleanUsername, cleanEmail || null)) {
            return res.send(renderRegisterPage('Bunday foydalanuvchi nomi band', true));
        }

        // ---------- No email given: create the account immediately, no verification needed ----------
        if (!cleanEmail) {
            const hashed = await bcrypt.hash(password, 10);
            const userId = await createUser(cleanUsername, null, hashed, 1);
            req.session.userId = userId;
            req.session.username = cleanUsername;
            return res.redirect('/home');
        }

        // ---------- Email given: nothing is written to the real `users` table yet ----------
        // The account is only created once the verification code is confirmed
        // (see POST /verify below). This is what stops half-finished signups
        // from permanently occupying a username/email if the code never arrives
        // or is never entered.
        const existingEmail = await getUserByEmail(cleanEmail);
        if (existingEmail) {
            return res.send(renderRegisterPage('Bu email allaqachon ro‘yxatdan o‘tgan', true));
        }

        const hashed = await bcrypt.hash(password, 10);
        await createPendingRegistration(cleanEmail, cleanUsername, hashed);

        try {
            const code = await createVerificationCode(cleanEmail, 'register');
            await sendEmail(cleanEmail, 'BirMillat — tasdiqlash kodi', verificationEmailHtml(code));
        } catch (emailErr) {
            console.error('Failed to send verification email during registration (pending registration still saved, resend available):', emailErr);
        }

        res.redirect(`/verify?email=${encodeURIComponent(cleanEmail)}`);
    } catch (err) {
        console.error('Register error:', err);
        res.send(renderRegisterPage('Server xatosi, qaytadan urinib ko‘ring', true));
    }
});

function renderVerifyPage(email, message, isError = true) {
    const msgClass = isError ? 'error' : 'success';
    return `<!DOCTYPE html><html><head><title>Emailni tasdiqlash - BirMillat</title>
    <link rel="icon" type="image/png" href="/favicon.png">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/style.css">
    <style>
        .auth-logo { height: 40px; margin-bottom: 1rem; }
        .code-input {
            font-size: 1.6rem; letter-spacing: 6px; text-align: center;
            font-weight: 700; color: var(--color-primary);
        }
        .resend-link { font-size: 0.85rem; margin-top: 0.8rem; display: inline-block; }
    </style>
    </head>
    <body class="auth-shell"><div class="auth-card">
        <img src="/logo-full.svg" alt="BirMillat" class="auth-logo">
        <h2>Emailni tasdiqlash</h2>
        <p style="color:var(--color-text-muted); font-size:0.9rem; margin-bottom:1rem;">
            <strong>${email}</strong> manziliga 6 xonali kod yubordik.
        </p>
        ${message ? `<div class="message ${msgClass}">${message}</div>` : ''}
        <form method=post action=/verify>
            <input type=hidden name=email value="${email}">
            <input name=code class="code-input" placeholder="000000" maxlength=6 inputmode="numeric" required>
            <button type=submit>Tasdiqlash</button>
        </form>
        <form method=post action=/verify/resend>
            <input type=hidden name=email value="${email}">
            <button type=submit class="resend-link" style="background:none; border:none; color:var(--color-accent); cursor:pointer; width:auto; padding:0;">Kodni qayta yuborish</button>
        </form>
    </div></body></html>`;
}

app.get('/verify', (req, res) => {
    const email = (req.query.email || '').trim().toLowerCase();
    if (!email) return res.redirect('/register');
    res.send(renderVerifyPage(email, ''));
});

app.post('/verify', async (req, res) => {
    try {
        const email = (req.body.email || '').trim().toLowerCase();
        const code = (req.body.code || '').trim();

        const result = await verifyCode(email, code, 'register');
        if (!result.valid) {
            return res.send(renderVerifyPage(email, result.reason, true));
        }

        // Code confirmed — this is the moment the real account gets created.
        const pending = await getPendingRegistration(email);
        if (!pending) {
            return res.send(renderVerifyPage(email, 'So‘rov muddati tugagan. Iltimos, qaytadan ro‘yxatdan o‘ting.', true));
        }

        // Re-check uniqueness right before creating — another user could have
        // taken this username/email in the meantime.
        const existingUsername = await getUser(pending.username);
        const existingEmailAcct = await getUserByEmail(email);
        if (existingUsername || existingEmailAcct) {
            await deletePendingRegistration(email);
            return res.send(renderVerifyPage(email, 'Bu foydalanuvchi nomi yoki email allaqachon band. Qaytadan ro‘yxatdan o‘ting.', true));
        }

        const userId = await createUser(pending.username, email, pending.password_hash, 1);
        await deletePendingRegistration(email);

        req.session.userId = userId;
        req.session.username = pending.username;
        res.redirect('/home');
    } catch (err) {
        console.error('Verify error:', err);
        res.send(renderVerifyPage(req.body.email || '', 'Server xatosi', true));
    }
});

app.post('/verify/resend', async (req, res) => {
    try {
        const email = (req.body.email || '').trim().toLowerCase();
        const pending = await getPendingRegistration(email);
        if (!pending) {
            return res.send(renderVerifyPage(email, 'So‘rov muddati tugagan. Iltimos, qaytadan ro‘yxatdan o‘ting.', true));
        }
        const code = await createVerificationCode(email, 'register');
        await sendEmail(email, 'BirMillat — tasdiqlash kodi', verificationEmailHtml(code));
        res.send(renderVerifyPage(email, 'Yangi kod yuborildi', false));
    } catch (err) {
        console.error('Resend code error:', err);
        res.send(renderVerifyPage(req.body.email || '', 'Server xatosi', true));
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

app.get('/contact', (req, res) => {
    res.sendFile(path.join(__dirname, 'contact.html'));
});

app.get('/support', (req, res) => {
    res.sendFile(path.join(__dirname, 'support.html'));
});

app.get('/events', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'events.html'));
});

app.get('/events/create', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'event-create.html'));
});

app.get('/events/:id', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'event-detail.html'));
});

app.get('/communities', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'communities.html'));
});

app.get('/communities/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'community-chat.html'));
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

// ---------- Forgot password flow ----------
function renderForgotPasswordPage(message, isError = true) {
    const msgClass = isError ? 'error' : 'success';
    return `<!DOCTYPE html><html><head><title>Parolni tiklash - BirMillat</title>
    <link rel="icon" type="image/png" href="/favicon.png">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/style.css">
    <style>.auth-logo { height: 40px; margin-bottom: 1rem; }</style>
    </head>
    <body class="auth-shell"><div class="auth-card">
        <img src="/logo-full.svg" alt="BirMillat" class="auth-logo">
        <h2>Parolni tiklash</h2>
        <p style="color:var(--color-text-muted); font-size:0.9rem; margin-bottom:1rem;">Ro'yxatdan o'tgan email manzilingizni kiriting — kod yuboramiz.</p>
        ${message ? `<div class="message ${msgClass}">${message}</div>` : ''}
        <form method=post action=/forgot-password>
            <input type=email name=email placeholder="Email manzilingiz" required>
            <button type=submit>Kod yuborish</button>
        </form>
        <p><a href=/login style="font-size:0.85rem;">Kirishga qaytish</a></p>
    </div></body></html>`;
}

function renderResetPasswordPage(email, message, isError = true) {
    const msgClass = isError ? 'error' : 'success';
    return `<!DOCTYPE html><html><head><title>Yangi parol - BirMillat</title>
    <link rel="icon" type="image/png" href="/favicon.png">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/style.css">
    <style>
        .auth-logo { height: 40px; margin-bottom: 1rem; }
        .code-input { font-size: 1.4rem; letter-spacing: 4px; text-align: center; font-weight: 700; color: var(--color-primary); }
    </style>
    </head>
    <body class="auth-shell"><div class="auth-card">
        <img src="/logo-full.svg" alt="BirMillat" class="auth-logo">
        <h2>Yangi parol o'rnatish</h2>
        <p style="color:var(--color-text-muted); font-size:0.9rem; margin-bottom:1rem;"><strong>${email}</strong> manziliga yuborilgan kodni kiriting.</p>
        ${message ? `<div class="message ${msgClass}">${message}</div>` : ''}
        <form method=post action=/reset-password>
            <input type=hidden name=email value="${email}">
            <input name=code class="code-input" placeholder="000000" maxlength=6 inputmode="numeric" required>
            <input type=password name=password placeholder="Yangi parol (kamida 8 belgi)" minlength=8 required>
            <input type=password name=confirmPassword placeholder="Yangi parolni takrorlang" minlength=8 required>
            <button type=submit>Parolni saqlash</button>
        </form>
    </div></body></html>`;
}

app.get('/forgot-password', (req, res) => {
    res.send(renderForgotPasswordPage(''));
});

app.post('/forgot-password', async (req, res) => {
    try {
        const email = (req.body.email || '').trim().toLowerCase();
        const user = await getUserByEmail(email);

        // Always show the same message whether or not the email exists,
        // so this endpoint can't be used to check which emails are registered.
        if (user) {
            const code = await createVerificationCode(email, 'reset');
            await sendEmail(email, 'BirMillat — parolni tiklash kodi', verificationEmailHtml(code));
        }

        res.send(renderResetPasswordPage(email, 'Agar bu email ro‘yxatdan o‘tgan bo‘lsa, kod yuborildi.', false));
    } catch (err) {
        console.error('Forgot password error:', err);
        res.send(renderForgotPasswordPage('Server xatosi, qaytadan urinib ko‘ring', true));
    }
});

app.post('/reset-password', async (req, res) => {
    try {
        const email = (req.body.email || '').trim().toLowerCase();
        const { code, password, confirmPassword } = req.body;

        if (password.length < 8) {
            return res.send(renderResetPasswordPage(email, 'Parol kamida 8 belgi bo‘lishi kerak', true));
        }
        if (password !== confirmPassword) {
            return res.send(renderResetPasswordPage(email, 'Parollar mos kelmadi', true));
        }

        const result = await verifyCode(email, code, 'reset');
        if (!result.valid) {
            return res.send(renderResetPasswordPage(email, result.reason, true));
        }

        const hashed = await bcrypt.hash(password, 10);
        await updateUserPassword(email, hashed);

        res.send(renderLoginPage('Parolingiz yangilandi. Endi kirishingiz mumkin.', false));
    } catch (err) {
        console.error('Reset password error:', err);
        res.send(renderResetPasswordPage(req.body.email || '', 'Server xatosi', true));
    }
});

// API endpoints
app.get('/api/me', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const user = await getUserById(req.session.userId);
        if (!user) return res.status(401).json({ error: 'Unauthorized' });
        res.json({
            id: user.id,
            username: user.username,
            name: user.name,
            bio: user.bio,
            interests: JSON.parse(user.interests || '[]'),
            photoUrl: user.photo_url,
            birthdate: user.birthdate,
            age: calculateAge(user.birthdate),
            region: user.region
        });
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
            return {
                username: u.username,
                name: u.name,
                bio: u.bio,
                interests: theirInterests,
                photoUrl: u.photo_url,
                age: calculateAge(u.birthdate),
                region: u.region,
                matchScore: common
            };
        }).sort((a, b) => b.matchScore - a.matchScore);
        res.json(scored);
    } catch (err) {
        console.error('api/recommendations error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

const UZ_REGIONS = [
    'Toshkent shahri', 'Toshkent viloyati', 'Andijon', 'Buxoro', "Farg'ona",
    'Jizzax', 'Xorazm', 'Namangan', 'Navoiy', 'Qashqadaryo', 'Samarqand',
    'Sirdaryo', 'Surxondaryo', "Qoraqalpog'iston"
];

const FREEIMAGE_API_KEY = process.env.FREEIMAGE_API_KEY;

async function uploadImageToFreeimage(buffer) {
    if (!FREEIMAGE_API_KEY) {
        console.error('FREEIMAGE_API_KEY is not set');
        return { ok: false, error: 'Server konfiguratsiyasi xato' };
    }

    const base64Image = buffer.toString('base64');
    const form = new URLSearchParams();
    form.append('key', FREEIMAGE_API_KEY);
    form.append('action', 'upload');
    form.append('source', base64Image);
    form.append('format', 'json');

    const uploadRes = await fetch('https://freeimage.host/api/1/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form
    });
    const data = await uploadRes.json();

    if (!uploadRes.ok || data.status_code !== 200 || !data.image) {
        console.error('Freeimage upload failed:', data);
        return { ok: false, error: 'Rasmni yuklab bo‘lmadi' };
    }

    return { ok: true, url: data.image.display_url || data.image.url };
}

app.post('/api/profile/photo', upload.single('photo'), async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Rasm tanlanmadi' });
        }

        const uploadResult = await uploadImageToFreeimage(req.file.buffer);
        if (!uploadResult.ok) {
            return res.status(500).json({ error: uploadResult.error });
        }

        await updateUserPhoto(req.session.userId, uploadResult.url);
        res.json({ success: true, photoUrl: uploadResult.url });
    } catch (err) {
        console.error('api/profile/photo error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ---------- Achievements API ----------
app.get('/api/users/:username/achievements', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const user = await getUser(req.params.username);
        if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
        const achievements = await getAchievementsByUserId(user.id);
        res.json(achievements.map(a => ({
            id: a.id,
            title: a.title,
            imageUrl: a.image_url,
            description: a.description,
            achievedDate: a.achieved_date
        })));
    } catch (err) {
        console.error('api/users/:username/achievements error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/achievements', upload.single('image'), async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const { title, description, achievedDate } = req.body;
        if (!title || !title.trim()) {
            return res.status(400).json({ error: 'Sarlavha kerak' });
        }
        if (!req.file) {
            return res.status(400).json({ error: 'Rasm tanlanmadi' });
        }

        const existingCount = await countAchievements(req.session.userId);
        if (existingCount >= MAX_ACHIEVEMENTS_PER_USER) {
            return res.status(400).json({ error: `Maksimal ${MAX_ACHIEVEMENTS_PER_USER} ta yutuq qo'shish mumkin` });
        }

        const uploadResult = await uploadImageToFreeimage(req.file.buffer);
        if (!uploadResult.ok) {
            return res.status(500).json({ error: uploadResult.error });
        }

        const id = await createAchievement(req.session.userId, {
            title: title.trim(),
            imageUrl: uploadResult.url,
            description: (description || '').trim(),
            achievedDate: achievedDate || null
        });

        res.json({ success: true, id, imageUrl: uploadResult.url });
    } catch (err) {
        console.error('api/achievements create error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/api/achievements/:id', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const success = await deleteAchievement(req.params.id, req.session.userId);
        if (!success) return res.status(404).json({ error: "Yutuq topilmadi" });
        res.json({ success: true });
    } catch (err) {
        console.error('api/achievements delete error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/profile/update', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const { name, bio, interests, birthdate, region } = req.body;

        if (region && !UZ_REGIONS.includes(region)) {
            return res.status(400).json({ error: "Noto'g'ri viloyat tanlandi" });
        }
        if (birthdate) {
            const parsed = new Date(birthdate);
            if (isNaN(parsed.getTime()) || parsed > new Date()) {
                return res.status(400).json({ error: "Tug'ilgan sana noto'g'ri" });
            }
        }

        const user = await getUserById(req.session.userId);
        await updateUserProfile(user.username, { name, bio, interests, birthdate, region });
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

        const results = rows.map(u => ({
            username: u.username,
            name: u.name,
            bio: u.bio,
            interests: JSON.parse(u.interests || '[]'),
            photoUrl: u.photo_url,
            age: calculateAge(u.birthdate),
            region: u.region
        }));
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
            interests: JSON.parse(user.interests || '[]'),
            photoUrl: user.photo_url,
            age: calculateAge(user.birthdate),
            region: user.region
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

// ---------- Email sending (Resend) ----------
const RESEND_API_KEY = process.env.RESEND_API_KEY;
// NOTE: until birmillat.uz is verified as a sending domain in Resend, this
// "from" address must stay as onboarding@resend.dev, and Resend will only
// actually deliver to the email address on the Resend account itself.
const EMAIL_FROM = process.env.RESEND_FROM_EMAIL || 'BirMillat <onboarding@resend.dev>';

async function sendEmail(to, subject, html) {
    if (!RESEND_API_KEY) {
        console.error('RESEND_API_KEY is not set — cannot send email');
        return { ok: false };
    }
    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ from: EMAIL_FROM, to, subject, html })
    });
    if (!res.ok) {
        const errText = await res.text();
        console.error('Resend send failed:', res.status, errText);
        return { ok: false };
    }
    return { ok: true };
}

function verificationEmailHtml(code) {
    return `
    <div style="font-family:sans-serif; max-width:420px; margin:0 auto; padding:2rem; background:#FAF7F2;">
        <h2 style="color:#2D1B69;">BirMillat</h2>
        <p style="color:#1A1625; font-size:16px;">Tasdiqlash kodingiz:</p>
        <div style="font-size:32px; font-weight:700; letter-spacing:4px; color:#FF6B5B; margin:1rem 0;">${code}</div>
        <p style="color:#6B6478; font-size:13px;">Bu kod 15 daqiqa davomida amal qiladi. Agar siz bu so'rovni yubormagan bo'lsangiz, bu xabarni e'tiborsiz qoldiring.</p>
    </div>`;
}

// ---------- Telegram bot notifications (reports + contact/ads inquiries) ----------
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ADMIN_CHAT_ID = '8220562180';

async function sendTelegramMessageTo(chatId, text, replyMarkup) {
    if (!TELEGRAM_BOT_TOKEN) {
        console.error('TELEGRAM_BOT_TOKEN is not set — cannot send Telegram notification');
        return { ok: false };
    }
    const body = { chat_id: chatId, text, parse_mode: 'HTML' };
    if (replyMarkup) body.reply_markup = replyMarkup;

    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return res.json();
}

async function sendTelegramPhotoTo(chatId, buffer, filename, caption) {
    if (!TELEGRAM_BOT_TOKEN) {
        console.error('TELEGRAM_BOT_TOKEN is not set — cannot send Telegram notification');
        return { ok: false };
    }
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    form.append('photo', new Blob([buffer]), filename || 'screenshot.jpg');

    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
        method: 'POST',
        body: form
    });
    return res.json();
}

// Existing callers throughout the file use these two, always targeting you (the admin).
async function sendTelegramMessage(text) {
    return sendTelegramMessageTo(TELEGRAM_ADMIN_CHAT_ID, text);
}

async function sendTelegramPhoto(buffer, filename, caption) {
    return sendTelegramPhotoTo(TELEGRAM_ADMIN_CHAT_ID, buffer, filename, caption);
}

function escapeHtmlForTelegram(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ---------- Telegram webhook: /block and /unblock admin commands ----------
// Security has three layers:
//  1. The URL path includes the bot token itself — only Telegram and you know this.
//  2. Telegram's X-Telegram-Bot-Api-Secret-Token header is checked against our own secret.
//  3. Even if both of those were somehow bypassed, commands are only honored if they
//     come from your specific Telegram chat ID — nobody else's /block command does anything.
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || 'change-me-webhook-secret';

app.post(`/telegram/webhook/${TELEGRAM_BOT_TOKEN}`, async (req, res) => {
    // Always respond 200 quickly so Telegram doesn't retry — even on auth failures,
    // since we don't want to leak info via different response codes.
    res.sendStatus(200);

    const headerToken = req.get('X-Telegram-Bot-Api-Secret-Token');
    if (headerToken !== TELEGRAM_WEBHOOK_SECRET) {
        console.warn('Telegram webhook: secret token mismatch, ignoring request');
        return;
    }

    const message = req.body && req.body.message;
    if (!message || !message.chat) return;

    const fromChatId = String(message.chat.id);
    const isAdmin = fromChatId === TELEGRAM_ADMIN_CHAT_ID;

    try {
        // ---------- Admin chat: commands, or a reply to forward back to a user ----------
        if (isAdmin) {
            if (message.reply_to_message) {
                // You replied (Telegram's native Reply) to a message we forwarded —
                // route your reply back to whichever user that thread belongs to.
                const repliedToId = String(message.reply_to_message.message_id);
                const thread = await findSupportThreadByAdminMessageId(repliedToId);
                if (!thread) {
                    await sendTelegramMessage("⚠️ Bu xabarning kimga tegishli ekanini topa olmadim.");
                    return;
                }

                const replyText = message.text || message.caption || '';
                if (thread.telegram_chat_id && thread.telegram_chat_id !== 'website') {
                    await sendTelegramMessageTo(thread.telegram_chat_id, replyText);
                }
                await recordSupportMessage({
                    telegramChatId: thread.telegram_chat_id,
                    websiteUsername: thread.website_username,
                    direction: 'out',
                    content: replyText
                });
                await sendTelegramMessage("✅ Javobingiz yuborildi.");
                return;
            }

            const text = (message.text || '').trim();
            const blockMatch = text.match(/^\/block\s+@?(\S+)/i);
            const unblockMatch = text.match(/^\/unblock\s+@?(\S+)/i);

            if (blockMatch) {
                const username = blockMatch[1];
                const success = await setUserBlocked(username, true);
                await sendTelegramMessage(success
                    ? `🚫 @${escapeHtmlForTelegram(username)} bloklandi.`
                    : `❌ @${escapeHtmlForTelegram(username)} topilmadi.`);
            } else if (unblockMatch) {
                const username = unblockMatch[1];
                const success = await setUserBlocked(username, false);
                await sendTelegramMessage(success
                    ? `✅ @${escapeHtmlForTelegram(username)} blokdan chiqarildi.`
                    : `❌ @${escapeHtmlForTelegram(username)} topilmadi.`);
            } else if (text === '/start' || text === '/help') {
                await sendTelegramMessage(
                    `<b>BirMillat admin buyruqlari</b>\n\n` +
                    `/block foydalanuvchi_nomi — hisobni bloklash\n` +
                    `/unblock foydalanuvchi_nomi — blokdan chiqarish\n\n` +
                    `Foydalanuvchiga javob berish uchun, uning xabariga Telegram'ning "Reply" funksiyasidan foydalaning.`
                );
            }
            return;
        }

        // ---------- Anyone else: treat as an incoming support message ----------
        const fromName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') ||
            message.from?.username || 'Noma\'lum';

        let forwarded;
        const captionHeader = `💬 <b>Yordam so'rovi</b>\nKimdan: ${escapeHtmlForTelegram(fromName)} (Telegram)`;

        if (message.photo && message.photo.length > 0) {
            // Telegram sends multiple resolutions; the last one is the largest.
            const fileId = message.photo[message.photo.length - 1].file_id;
            const fileRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
            const fileData = await fileRes.json();
            if (fileData.ok) {
                const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${fileData.result.file_path}`;
                const imgRes = await fetch(fileUrl);
                const buffer = Buffer.from(await imgRes.arrayBuffer());
                const caption = `${captionHeader}\n${message.caption ? escapeHtmlForTelegram(message.caption) : ''}`;
                forwarded = await sendTelegramPhoto(buffer, 'support.jpg', caption);
            }
        } else if (message.text) {
            const text = `${captionHeader}\n\n${escapeHtmlForTelegram(message.text)}`;
            forwarded = await sendTelegramMessage(text);
        }

        if (forwarded && forwarded.ok && forwarded.result) {
            await recordSupportMessage({
                telegramChatId: fromChatId,
                websiteUsername: null,
                direction: 'in',
                content: message.text || message.caption || '[rasm]',
                adminMessageId: forwarded.result.message_id
            });
            await sendTelegramMessageTo(fromChatId, "Xabaringiz qabul qilindi. Tez orada javob beramiz!");
        }
    } catch (err) {
        console.error('Telegram webhook error:', err);
    }
});

// Website support: submit a message (+ optional screenshot), routed through
// the same admin reply mechanism as direct Telegram messages.
app.post('/api/support', upload.single('screenshot'), async (req, res) => {
    try {
        const { message, claimedUsername } = req.body;
        const sessionUser = req.session.userId ? await getUserById(req.session.userId) : null;
        const username = sessionUser?.username || null;

        let identity;
        if (username) {
            identity = `@${username} (vebsayt, tizimga kirgan)`;
        } else if (claimedUsername && claimedUsername.trim()) {
            // Not logged in (e.g. a blocked account) — they typed their username manually.
            // Label it clearly as unverified since we can't confirm it ourselves.
            identity = `@${escapeHtmlForTelegram(claimedUsername.trim())} (o'zi yozgan, tasdiqlanmagan)`;
        } else {
            identity = "Mehmon (username ko'rsatilmagan)";
        }

        const captionHeader = `💬 <b>Yordam so'rovi</b>\nKimdan: ${identity}`;

        let forwarded;
        if (req.file) {
            const caption = `${captionHeader}\n${message ? escapeHtmlForTelegram(message) : ''}`;
            forwarded = await sendTelegramPhoto(req.file.buffer, req.file.originalname, caption);
        } else {
            if (!message || !message.trim()) {
                return res.status(400).json({ error: 'Xabar bo‘sh bo‘lishi mumkin emas' });
            }
            forwarded = await sendTelegramMessage(`${captionHeader}\n\n${escapeHtmlForTelegram(message)}`);
        }

        if (forwarded && forwarded.ok && forwarded.result) {
            await recordSupportMessage({
                telegramChatId: 'website',
                websiteUsername: username || (claimedUsername ? claimedUsername.trim() : null),
                direction: 'in',
                content: message || '[rasm]',
                adminMessageId: forwarded.result.message_id
            });
        }

        res.json({ success: true });
    } catch (err) {
        console.error('api/support error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Poll for admin replies to this user's website support thread
app.get('/api/support/replies', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const user = await getUserById(req.session.userId);
        const result = await db.execute({
            sql: `SELECT content, created_at FROM support_messages
                  WHERE website_username = ? AND direction = 'out'
                  ORDER BY created_at ASC`,
            args: [user.username]
        });
        res.json(result.rows);
    } catch (err) {
        console.error('api/support/replies error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Report a user, with an optional screenshot attached
app.post('/api/report', upload.single('screenshot'), async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const reporter = await getUserById(req.session.userId);
        const { reportedUsername, reason, details } = req.body;

        if (!reportedUsername || !reason) {
            return res.status(400).json({ error: "Foydalanuvchi va sabab ko'rsatilishi shart" });
        }

        const caption =
            `🚩 <b>Yangi shikoyat</b>\n\n` +
            `<b>Shikoyat qilingan:</b> @${escapeHtmlForTelegram(reportedUsername)}\n` +
            `<b>Shikoyat qildi:</b> @${escapeHtmlForTelegram(reporter.username)}\n` +
            `<b>Sabab:</b> ${escapeHtmlForTelegram(reason)}\n` +
            (details ? `<b>Tafsilotlar:</b> ${escapeHtmlForTelegram(details)}` : '');

        if (req.file) {
            await sendTelegramPhoto(req.file.buffer, req.file.originalname, caption);
        } else {
            await sendTelegramMessage(caption);
        }

        res.json({ success: true });
    } catch (err) {
        console.error('api/report error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// General contact / business / ad inquiries — no login required
app.post('/api/contact', async (req, res) => {
    try {
        const { name, contact, message } = req.body;
        if (!message || !message.trim()) {
            return res.status(400).json({ error: 'Xabar bo‘sh bo‘lishi mumkin emas' });
        }

        const text =
            `📩 <b>Yangi murojaat</b>\n\n` +
            `<b>Ism:</b> ${escapeHtmlForTelegram(name || 'Ko‘rsatilmagan')}\n` +
            `<b>Aloqa:</b> ${escapeHtmlForTelegram(contact || 'Ko‘rsatilmagan')}\n` +
            `<b>Xabar:</b> ${escapeHtmlForTelegram(message)}`;

        await sendTelegramMessage(text);
        res.json({ success: true });
    } catch (err) {
        console.error('api/contact error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ---------- Events ----------
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-me-admin-secret';
const SITE_URL = process.env.SITE_URL || 'https://birmillat.uz';

app.get('/api/events', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const category = (req.query.category || '').trim();
        const events = await getApprovedEvents(category || null);
        res.json(events);
    } catch (err) {
        console.error('api/events error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/events/:id', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const event = await getEventById(req.params.id);
        if (!event || event.status !== 'approved') {
            return res.status(404).json({ error: 'Tadbir topilmadi' });
        }
        const attendees = await getEventAttendees(event.id);
        const isAttending = await isUserAttending(event.id, req.session.userId);
        res.json({ ...event, attendees, isAttending, isCreator: event.creator_id === req.session.userId });
    } catch (err) {
        console.error('api/events/:id error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/events', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const { title, description, category, mode, location, eventDate, capacity } = req.body;
        if (!title || !title.trim()) {
            return res.status(400).json({ error: 'Tadbir nomi kerak' });
        }
        if (!eventDate) {
            return res.status(400).json({ error: 'Sana kerak' });
        }
        const parsedDate = new Date(eventDate).getTime();
        if (isNaN(parsedDate)) {
            return res.status(400).json({ error: 'Sana noto‘g‘ri' });
        }

        const creator = await getUserById(req.session.userId);
        const eventId = await createEvent({
            creatorId: req.session.userId,
            title: title.trim(),
            description: (description || '').trim(),
            category: category || 'Boshqa',
            mode: mode === 'online' ? 'online' : 'in_person',
            location: (location || '').trim(),
            eventDate: parsedDate,
            capacity: capacity ? parseInt(capacity, 10) : null
        });

        const approveUrl = `${SITE_URL}/admin/events/${eventId}/approve?token=${ADMIN_SECRET}`;
        const rejectUrl = `${SITE_URL}/admin/events/${eventId}/reject?token=${ADMIN_SECRET}`;
        const dateStr = new Date(parsedDate).toLocaleString('uz-UZ', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

        const text =
            `🗓 <b>Yangi tadbir so'rovi</b>\n\n` +
            `<b>Sarlavha:</b> ${escapeHtmlForTelegram(title)}\n` +
            `<b>Muallif:</b> @${escapeHtmlForTelegram(creator.username)}\n` +
            `<b>Kategoriya:</b> ${escapeHtmlForTelegram(category || 'Boshqa')}\n` +
            `<b>Sana:</b> ${dateStr}\n` +
            `<b>Joylashuv:</b> ${escapeHtmlForTelegram(location || '—')}\n` +
            (description ? `<b>Tavsif:</b> ${escapeHtmlForTelegram(description)}\n\n` : '\n') +
            `✅ Tasdiqlash: ${approveUrl}\n` +
            `❌ Rad etish: ${rejectUrl}`;

        await sendTelegramMessage(text);
        res.json({ success: true });
    } catch (err) {
        console.error('api/events create error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/events/:id/join', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const event = await getEventById(req.params.id);
        if (!event || event.status !== 'approved') {
            return res.status(404).json({ error: 'Tadbir topilmadi' });
        }
        await joinEvent(event.id, req.session.userId);
        res.json({ success: true });
    } catch (err) {
        console.error('api/events/:id/join error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/events/:id/leave', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        await leaveEvent(req.params.id, req.session.userId);
        res.json({ success: true });
    } catch (err) {
        console.error('api/events/:id/leave error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Simple one-tap admin approval — no login needed, gated by a secret token
// known only to you (sent in the Telegram notification link).
app.get('/admin/events/:id/approve', async (req, res) => {
    if (req.query.token !== ADMIN_SECRET) return res.status(403).send('Forbidden');
    await setEventStatus(req.params.id, 'approved');
    res.send('✅ Tadbir tasdiqlandi. Bu oynani yopishingiz mumkin.');
});

app.get('/admin/events/:id/reject', async (req, res) => {
    if (req.query.token !== ADMIN_SECRET) return res.status(403).send('Forbidden');
    await setEventStatus(req.params.id, 'rejected');
    res.send('❌ Tadbir rad etildi. Bu oynani yopishingiz mumkin.');
});

// One-off cleanup tool for accounts stuck unverified from BEFORE this fix
// shipped (the old flow created a real `users` row immediately on submit).
// New registrations no longer create a users row until verification succeeds,
// so this tool mainly matters for pre-existing stuck test accounts.
app.get('/admin/cleanup-unverified', async (req, res) => {
    if (req.query.token !== ADMIN_SECRET) return res.status(403).send('Forbidden');
    const username = (req.query.username || '').trim();
    if (!username) return res.send('Usage: ?token=...&username=...');

    const user = await getUser(username);
    if (!user) return res.send(`Foydalanuvchi "${username}" topilmadi.`);
    if (user.is_verified) {
        return res.send(`@${username} hisobi allaqachon tasdiqlangan — bu vosita orqali o'chirib bo'lmaydi.`);
    }

    await db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [user.id] });
    res.send(`@${username} (tasdiqlanmagan hisob) o'chirildi. Endi bu nom va email qaytadan ro'yxatdan o'tish uchun bo'sh.`);
});

// ---------- Communities ----------
app.get('/api/communities', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const category = (req.query.category || '').trim();
        const communities = await listCommunities(category || null);
        res.json(communities);
    } catch (err) {
        console.error('api/communities error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/communities', upload.single('image'), async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const { name, description, category } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ error: 'Jamoa nomi kerak' });
        }

        let imageUrl = null;
        if (req.file) {
            const uploadResult = await uploadImageToFreeimage(req.file.buffer);
            if (uploadResult.ok) imageUrl = uploadResult.url;
        }

        const id = await createCommunity(req.session.userId, {
            name: name.trim(),
            description: (description || '').trim(),
            category: category || 'Boshqa',
            imageUrl
        });
        res.json({ success: true, id });
    } catch (err) {
        console.error('api/communities create error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/communities/:id/image', upload.single('image'), async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const community = await getCommunityById(req.params.id);
        if (!community) return res.status(404).json({ error: 'Jamoa topilmadi' });
        if (community.creator_id !== req.session.userId) {
            return res.status(403).json({ error: "Faqat jamoa yaratuvchisi rasmni o'zgartirishi mumkin" });
        }
        if (!req.file) return res.status(400).json({ error: 'Rasm tanlanmadi' });

        const uploadResult = await uploadImageToFreeimage(req.file.buffer);
        if (!uploadResult.ok) return res.status(500).json({ error: uploadResult.error });

        await updateCommunityImage(req.params.id, uploadResult.url);
        res.json({ success: true, imageUrl: uploadResult.url });
    } catch (err) {
        console.error('api/communities/:id/image error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/communities/:id', async (req, res) => {
    try {
        const community = await getCommunityById(req.params.id);
        if (!community) return res.status(404).json({ error: 'Jamoa topilmadi' });

        const members = await getCommunityMembers(community.id);

        // Logged-out visitors get a preview only: no member list, no membership status.
        if (!req.session.userId) {
            return res.json({
                id: community.id,
                name: community.name,
                description: community.description,
                category: community.category,
                imageUrl: community.image_url,
                creatorUsername: community.creator_username,
                memberCount: members.length,
                isMember: false,
                isCreator: false,
                isPreview: true
            });
        }

        const isMember = await isCommunityMember(community.id, req.session.userId);
        const myRole = await getMemberRole(community.id, req.session.userId);
        const isCreator = community.creator_id === req.session.userId;
        const isAdmin = myRole === 'admin';

        res.json({
            ...community,
            imageUrl: community.image_url,
            members,
            memberCount: members.length,
            isMember,
            isCreator,
            isAdmin,
            canManage: isCreator || isAdmin,
            isPreview: false
        });
    } catch (err) {
        console.error('api/communities/:id error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/communities/:id/join', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const community = await getCommunityById(req.params.id);
        if (!community) return res.status(404).json({ error: 'Jamoa topilmadi' });
        await joinCommunity(community.id, req.session.userId);
        res.json({ success: true });
    } catch (err) {
        console.error('api/communities/:id/join error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/communities/:id/leave', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const community = await getCommunityById(req.params.id);
        if (!community) return res.status(404).json({ error: 'Jamoa topilmadi' });
        if (community.creator_id === req.session.userId) {
            return res.status(400).json({ error: "Jamoa yaratuvchisi chiqib ketolmaydi. Jamoani o'chirishingiz mumkin." });
        }
        await leaveCommunity(req.params.id, req.session.userId);
        res.json({ success: true });
    } catch (err) {
        console.error('api/communities/:id/leave error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/communities/:id/remove/:userId', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const community = await getCommunityById(req.params.id);
        if (!community) return res.status(404).json({ error: 'Jamoa topilmadi' });

        const canManage = await isCommunityAdminOrCreator(req.params.id, req.session.userId, community.creator_id);
        if (!canManage) {
            return res.status(403).json({ error: "Faqat jamoa yaratuvchisi yoki adminlar a'zolarni chiqarishi mumkin" });
        }
        if (Number(req.params.userId) === community.creator_id) {
            return res.status(400).json({ error: "Jamoa yaratuvchisini chiqarib bo'lmaydi" });
        }
        await removeCommunityMember(req.params.id, req.params.userId);
        res.json({ success: true });
    } catch (err) {
        console.error('api/communities/:id/remove error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/communities/:id/admins/:userId', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const community = await getCommunityById(req.params.id);
        if (!community) return res.status(404).json({ error: 'Jamoa topilmadi' });

        // Only the creator can promote/demote admins — admins can't promote other admins.
        if (community.creator_id !== req.session.userId) {
            return res.status(403).json({ error: "Faqat jamoa yaratuvchisi adminlarni tayinlashi mumkin" });
        }
        if (Number(req.params.userId) === community.creator_id) {
            return res.status(400).json({ error: "Jamoa yaratuvchisi allaqachon to'liq huquqlarga ega" });
        }

        const { action } = req.body; // 'promote' or 'demote'
        const newRole = action === 'promote' ? 'admin' : 'member';
        const success = await setMemberRole(req.params.id, req.params.userId, newRole);
        if (!success) return res.status(404).json({ error: "A'zo topilmadi" });

        res.json({ success: true, role: newRole });
    } catch (err) {
        console.error('api/communities/:id/admins error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/communities/:id/messages', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const isMember = await isCommunityMember(req.params.id, req.session.userId);
        if (!isMember) return res.status(403).json({ error: "Siz bu jamoaga a'zo emassiz" });

        const messages = await getCommunityMessages(req.params.id);
        res.json(messages.map(m => ({
            id: m.id,
            senderId: m.sender_id,
            senderUsername: m.username,
            senderName: m.name,
            senderPhoto: m.photo_url,
            content: m.content,
            createdAt: m.created_at,
            isMine: m.sender_id === req.session.userId,
            replyTo: m.reply_to_id ? {
                id: m.reply_to_id,
                content: m.reply_content,
                senderUsername: m.reply_username,
                senderName: m.reply_name
            } : null
        })));
    } catch (err) {
        console.error('api/communities/:id/messages error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});



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

    // ---------- Community group chat (Socket.IO rooms) ----------
    socket.on('join_community', async (data, callback) => {
        try {
            const communityId = data && data.communityId;
            if (!communityId) return;
            const isMember = await isCommunityMember(communityId, userId);
            if (!isMember) {
                if (callback) callback({ error: "Siz bu jamoaga a'zo emassiz" });
                return;
            }
            socket.join(`community:${communityId}`);
            if (callback) callback({ success: true });
        } catch (err) {
            console.error('join_community error:', err);
            if (callback) callback({ error: 'Server xatosi' });
        }
    });

    socket.on('leave_community_room', (data) => {
        const communityId = data && data.communityId;
        if (communityId) socket.leave(`community:${communityId}`);
    });

    socket.on('send_community_message', async (data, callback) => {
        try {
            const { communityId, content, replyToId } = data || {};
            const trimmed = (content || '').trim();
            if (!communityId || !trimmed) {
                if (callback) callback({ error: 'Xabar bo‘sh bo‘lishi mumkin emas' });
                return;
            }
            const isMember = await isCommunityMember(communityId, userId);
            if (!isMember) {
                if (callback) callback({ error: "Siz bu jamoaga a'zo emassiz" });
                return;
            }

            let replyToPayload = null;
            if (replyToId) {
                const original = await getCommunityMessageById(replyToId);
                if (original && Number(original.community_id) === Number(communityId)) {
                    replyToPayload = {
                        id: original.id,
                        content: original.content,
                        senderUsername: original.username,
                        senderName: original.name
                    };
                }
            }

            const sender = await getUserById(userId);
            const saved = await saveCommunityMessage(communityId, userId, trimmed, replyToPayload ? replyToId : null);
            const payload = {
                id: saved.id,
                communityId: Number(communityId),
                senderId: userId,
                senderUsername: sender.username,
                senderName: sender.name,
                senderPhoto: sender.photo_url,
                content: trimmed,
                createdAt: saved.createdAt,
                replyTo: replyToPayload
            };

            // Broadcast to everyone currently in this community's room, including the sender
            io.to(`community:${communityId}`).emit('new_community_message', payload);

            if (callback) callback({ success: true, message: payload });
        } catch (err) {
            console.error('send_community_message error:', err);
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
