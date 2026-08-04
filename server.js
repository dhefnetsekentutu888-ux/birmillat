const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const http = require('http');
const { Server: SocketIOServer } = require('socket.io');
const { createClient } = require('@libsql/client');
const multer = require('multer');
const webpush = require('web-push');

const app = express();
// Render (like virtually every PaaS) terminates HTTPS at a proxy and forwards
// requests to this app over plain HTTP internally, signaling the original
// protocol via X-Forwarded-Proto. Without this line, Express can't tell the
// request was actually HTTPS, so it refuses to send the `secure` session
// cookie at all — which breaks login completely, for everyone, since the
// browser never receives a session cookie to log in with.
app.set('trust proxy', 1);
const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer);
const PORT = process.env.PORT || 3000;

// ---------- Web Push (real OS/browser-level notifications, not email/Telegram) ----------
// Fallback keys included so this works immediately without extra setup —
// override with VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in Render's env vars if
// you ever want to rotate them (would require every user to re-subscribe).
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BL_of5M9VI6skJ9Co9D5E9pXdhvFB_ktOmr2hRZfp87Ui7ab2qbsqFMHsHqal2qQ8maoWDcNSR-lQtfNH68R1AQ';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'OgoF6jxOXbIYn7ThnxXwoUgF3LBeOkwfzldezcn_mWY';
webpush.setVapidDetails('mailto:support@birmillat.uz', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

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
    // Telegram account linking — lets us DM individual users notifications
    // (likes, messages, event joins) rather than only ever messaging the admin.
    try { await db.execute(`ALTER TABLE users ADD COLUMN telegram_chat_id TEXT`); } catch (e) {}
    try { await db.execute(`ALTER TABLE users ADD COLUMN telegram_link_token TEXT`); } catch (e) {}
    // Phone-based registration (verified via the Telegram bot instead of SMS).
    try { await db.execute(`ALTER TABLE users ADD COLUMN phone TEXT`); } catch (e) {}
    await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users (phone)`);
    // Opt-in flag: only members who explicitly turn this on (Profil sozlamalari)
    // can appear in the logged-out landing page's public "showcase" preview.
    // Default is off — nobody's photo/bio is public until they choose it.
    try { await db.execute(`ALTER TABLE users ADD COLUMN showcase_public INTEGER DEFAULT 0`); } catch (e) {}

    // In-app notification bell — separate from Telegram notifications, since
    // most users don't have that linked. This is what powers the bell icon
    // and its unread red dot in the navbar.
    await db.execute(`
        CREATE TABLE IF NOT EXISTS notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            type TEXT NOT NULL,
            content TEXT NOT NULL,
            link TEXT,
            is_read INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        )
    `);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, created_at)`);

    // Web Push subscriptions — real OS/browser-level notifications (the "top
    // shade on mobile" behavior), one row per device/browser a user enabled
    // notifications on.
    await db.execute(`
        CREATE TABLE IF NOT EXISTS push_subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            endpoint TEXT NOT NULL UNIQUE,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )
    `);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions (user_id)`);


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

    // Founders and core team members are public records managed only by the
    // account named in FOUNDER_ADMIN_USERNAME (configured in the host).
    await db.execute(`
        CREATE TABLE IF NOT EXISTS founders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            position TEXT NOT NULL,
            description TEXT NOT NULL,
            photo_url TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        )
    `);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_founders_sort ON founders (sort_order, created_at)`);
    // Social links shown as icon+label buttons on the "Ijtimoiy tarmoq" page —
    // all optional, all managed by the same founder-admin account.
    try { await db.execute(`ALTER TABLE founders ADD COLUMN instagram_url TEXT`); } catch (e) {}
    try { await db.execute(`ALTER TABLE founders ADD COLUMN telegram_url TEXT`); } catch (e) {}
    try { await db.execute(`ALTER TABLE founders ADD COLUMN linkedin_url TEXT`); } catch (e) {}

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

    // Pending registrations: holds username/password while a verification code
    // is outstanding. The real `users` row is only created once the code is
    // confirmed — this is what stops half-finished signups from permanently
    // occupying a username/email/phone if the person never completes it.
    // The `email` column doubles as a generic identifier: for phone signups it
    // holds the phone number instead — `method` says which one it actually is.
    await db.execute(`
        CREATE TABLE IF NOT EXISTS pending_registrations (
            email TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            method TEXT NOT NULL DEFAULT 'email',
            created_at INTEGER NOT NULL
        )
    `);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_pending_username ON pending_registrations (username)`);
    try { await db.execute(`ALTER TABLE pending_registrations ADD COLUMN method TEXT NOT NULL DEFAULT 'email'`); } catch (e) {}

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
    try { await db.execute(`ALTER TABLE events ADD COLUMN social_link TEXT`); } catch (e) {}
    try { await db.execute(`ALTER TABLE events ADD COLUMN map_link TEXT`); } catch (e) {}
    try { await db.execute(`ALTER TABLE events ADD COLUMN plan_link TEXT`); } catch (e) {}
    // "Yaqinda bo'lib o'tgan tadbirlar" — after an event's date has passed, its
    // creator can add a recap photo + short note, shown on the past-events tab.
    try { await db.execute(`ALTER TABLE events ADD COLUMN recap_image_url TEXT`); } catch (e) {}
    try { await db.execute(`ALTER TABLE events ADD COLUMN recap_note TEXT`); } catch (e) {}

    await db.execute(`
        CREATE TABLE IF NOT EXISTS event_attendees (
            event_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            joined_at INTEGER NOT NULL,
            PRIMARY KEY (event_id, user_id)
        )
    `);

    // ---------- Event organizing team, team gallery, participant feedback, QR check-in ----------
    // A coordinator is another user the event's creator has vouched for, with a
    // free-text role label the creator chooses themselves (e.g. "Moderator",
    // "Fotosurat"). Coordinators get the same event-management rights as the
    // creator (posting team updates, scanning check-in QR codes).
    await db.execute(`
        CREATE TABLE IF NOT EXISTS event_coordinators (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            role_label TEXT NOT NULL,
            added_by INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(event_id, user_id)
        )
    `);

    // The organizing team's own gallery/writeup for a past event — this is the
    // primary, featured content on the "Tashkil qilingan tadbirlar" tab.
    await db.execute(`
        CREATE TABLE IF NOT EXISTS event_team_posts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id INTEGER NOT NULL,
            author_id INTEGER NOT NULL,
            image_url TEXT,
            caption TEXT,
            created_at INTEGER NOT NULL
        )
    `);
    // Instagram-style multi-photo posts — image_url (singular) is kept only so
    // older rows created before this still have a cover image; every post
    // created from now on stores its full photo set here instead.
    try { await db.execute(`ALTER TABLE event_team_posts ADD COLUMN image_urls TEXT`); } catch (e) {}
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_team_posts_event ON event_team_posts (event_id, created_at)`);

    // Participant feedback on a past event — deliberately lighter-weight than
    // the team's posts (no star rating, just a note + optional photo), shown
    // secondary to the organizing team's content.
    await db.execute(`
        CREATE TABLE IF NOT EXISTS event_reviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            text TEXT,
            image_url TEXT,
            created_at INTEGER NOT NULL,
            UNIQUE(event_id, user_id)
        )
    `);

    // QR check-in passes. Created only after a participant confirms attendance
    // AND passes the Turnstile challenge (so a single click can't be spammed
    // into generating throwaway passes). The token is what's embedded in the
    // QR code; /checkin/:token is what an organizer's camera opens when they
    // scan it at the door.
    await db.execute(`
        CREATE TABLE IF NOT EXISTS event_checkins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            token TEXT UNIQUE NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            checked_in_at INTEGER,
            checked_in_by INTEGER,
            created_at INTEGER NOT NULL,
            UNIQUE(event_id, user_id)
        )
    `);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_checkins_token ON event_checkins (token)`);

    // ---------- Volunteer opportunities board ----------
    // Deliberately lighter-weight than events: no admin approval, posted and
    // live immediately — closer to a job-board listing than a public event.
    await db.execute(`
        CREATE TABLE IF NOT EXISTS volunteer_opportunities (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            creator_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            mode TEXT NOT NULL DEFAULT 'offline',
            city TEXT,
            social_link TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            created_at INTEGER NOT NULL
        )
    `);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_volunteer_status ON volunteer_opportunities (status, created_at)`);

    // A "hand raise" — someone expressing interest, with an optional short
    // note. One per person per opportunity.
    await db.execute(`
        CREATE TABLE IF NOT EXISTS volunteer_responses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            opportunity_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            message TEXT,
            created_at INTEGER NOT NULL,
            UNIQUE(opportunity_id, user_id)
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

    // Moderation: counts how many articles this user has had removed for
    // violating rules. Reaching 3 auto-bans the account (reuses setUserBlocked,
    // same mechanism as the existing Telegram /block command).
    try { await db.execute(`ALTER TABLE users ADD COLUMN warning_count INTEGER DEFAULT 0`); } catch (e) {}

    // Articles ("Maqolalar") — publish immediately, no pre-review. Quality is
    // enforced after the fact via reports: anyone can report an article, you
    // review the report on Telegram, and can delete it with one command,
    // which automatically issues a warning to the author.
    await db.execute(`
        CREATE TABLE IF NOT EXISTS articles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            author_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )
    `);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_articles_created ON articles (created_at)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_articles_author ON articles (author_id)`);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS article_likes (
            article_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (article_id, user_id)
        )
    `);

    // One report per user per article — prevents someone spamming reports to
    // pressure a takedown; you still see every distinct reporter's reason.
    await db.execute(`
        CREATE TABLE IF NOT EXISTS article_reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            article_id INTEGER NOT NULL,
            reporter_id INTEGER NOT NULL,
            reason TEXT,
            created_at INTEGER NOT NULL,
            UNIQUE(article_id, reporter_id)
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

async function getUserByEmail(email) {
    const result = await db.execute({
        sql: 'SELECT * FROM users WHERE email = ?',
        args: [email]
    });
    return result.rows[0] || null;
}

async function getUserByPhone(phone) {
    const result = await db.execute({
        sql: 'SELECT * FROM users WHERE phone = ?',
        args: [phone]
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

async function getUserByTelegramChatId(chatId) {
    const result = await db.execute({
        sql: 'SELECT * FROM users WHERE telegram_chat_id = ?',
        args: [String(chatId)]
    });
    return result.rows[0] || null;
}

async function createUser(username, email, phone, passwordHash, isVerified = 0) {
    const result = await db.execute({
        sql: 'INSERT INTO users (username, email, phone, password, name, is_verified) VALUES (?, ?, ?, ?, ?, ?)',
        args: [username, email || null, phone || null, passwordHash, username, isVerified]
    });
    return Number(result.lastInsertRowid);
}

// Wraps createUser to survive a duplicate-submission race: if two verify
// requests for the same pending registration land close together (e.g. a
// double-tap on a slow connection), both can pass the pre-check and one will
// hit a UNIQUE constraint violation on insert. Rather than surfacing that as
// "Server xatosi" to someone whose account was actually just created a moment
// earlier by their own other request, we detect that case and log them into
// the account that already exists instead of failing.
async function createUserSafely(username, email, phone, passwordHash) {
    try {
        return await createUser(username, email, phone, passwordHash, 1);
    } catch (err) {
        const existing = email ? await getUserByEmail(email) : (phone ? await getUserByPhone(phone) : await getUser(username));
        if (existing) {
            console.warn('createUserSafely: insert conflict, reusing existing account (likely a double-submit race):', username, email, phone);
            return existing.id;
        }
        throw err; // genuinely something else went wrong
    }
}

async function markUserVerified(email) {
    return db.execute({
        sql: 'UPDATE users SET is_verified = 1 WHERE email = ?',
        args: [email]
    });
}

async function markUserVerifiedByIdentifier(method, identifier) {
    const column = method === 'phone' ? 'phone' : 'email';
    return db.execute({
        sql: `UPDATE users SET is_verified = 1 WHERE ${column} = ?`,
        args: [identifier]
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

async function createPendingRegistration(identifier, username, passwordHash, method = 'email') {
    const now = Date.now();
    await db.execute({
        sql: `INSERT INTO pending_registrations (email, username, password_hash, method, created_at)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(email) DO UPDATE SET username = excluded.username, password_hash = excluded.password_hash, method = excluded.method, created_at = excluded.created_at`,
        args: [identifier, username, passwordHash, method, now]
    });
}

async function getPendingRegistration(identifier) {
    const result = await db.execute({ sql: 'SELECT * FROM pending_registrations WHERE email = ?', args: [identifier] });
    const row = result.rows[0];
    if (!row) return null;
    if (Date.now() - row.created_at > PENDING_REGISTRATION_TTL_MS) return null; // treat as expired
    return row;
}

async function deletePendingRegistration(identifier) {
    return db.execute({ sql: 'DELETE FROM pending_registrations WHERE email = ?', args: [identifier] });
}

// Username is considered taken if a real account has it, OR if someone else has
// a *fresh* (non-expired) pending registration holding it.
async function isUsernameTaken(username, excludeIdentifier = null) {
    const existing = await getUser(username);
    if (existing) return true;

    const result = await db.execute({ sql: 'SELECT email, created_at FROM pending_registrations WHERE username = ?', args: [username] });
    for (const row of result.rows) {
        if (excludeIdentifier && row.email === excludeIdentifier) continue; // a person re-submitting their own pending signup is fine
        if (Date.now() - row.created_at <= PENDING_REGISTRATION_TTL_MS) return true;
    }
    return false;
}

// Looks up an active (unused, unexpired) verification code with no known
// identifier — used for the phone/Telegram-bot flow, where the person pastes
// their code directly into a Telegram chat and we only have the code itself,
// not which phone number it belongs to.
async function findActiveCodeByCodeOnly(code, purpose) {
    const result = await db.execute({
        sql: `SELECT * FROM verification_codes WHERE code = ? AND purpose = ? AND used = 0 ORDER BY created_at DESC LIMIT 1`,
        args: [code, purpose]
    });
    const row = result.rows[0];
    if (!row) return null;
    if (row.expires_at < Date.now()) return null;
    return row;
}

async function updateUserProfile(username, { name, bio, interests, birthdate, region, showcasePublic }) {
    return db.execute({
        sql: `UPDATE users SET name = ?, bio = ?, interests = ?, birthdate = ?, region = ?, showcase_public = ? WHERE username = ?`,
        args: [name, bio, JSON.stringify(interests), birthdate || null, region || null, showcasePublic ? 1 : 0, username]
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

// ---------- Telegram account linking & per-user notifications ----------
function generateLinkToken() {
    return Array.from({ length: 20 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
}

async function createTelegramLinkToken(userId) {
    const token = generateLinkToken();
    await db.execute({ sql: 'UPDATE users SET telegram_link_token = ? WHERE id = ?', args: [token, userId] });
    return token;
}

// Called when someone messages the bot with /start <token>. Links that
// Telegram chat to whichever website account currently holds this token.
async function linkTelegramByToken(token, chatId) {
    const result = await db.execute({ sql: 'SELECT id, username FROM users WHERE telegram_link_token = ?', args: [token] });
    const user = result.rows[0];
    if (!user) return null;
    await db.execute({
        sql: 'UPDATE users SET telegram_chat_id = ?, telegram_link_token = NULL WHERE id = ?',
        args: [String(chatId), user.id]
    });
    return user;
}

// Fire-and-forget notification to a specific user's linked Telegram chat.
// Silently does nothing if they haven't linked an account — this must never
// throw and block the action that triggered it (a like/message/join should
// still succeed even if the notification fails).
async function notifyUserViaTelegram(userId, text) {
    try {
        const result = await db.execute({ sql: 'SELECT telegram_chat_id FROM users WHERE id = ?', args: [userId] });
        const chatId = result.rows[0] && result.rows[0].telegram_chat_id;
        if (!chatId) return;
        await sendTelegramMessageTo(chatId, text);
    } catch (err) {
        console.error('notifyUserViaTelegram failed (non-fatal):', err);
    }
}

// ---------- In-app notifications (bell icon) ----------
async function createNotification(userId, type, content, link) {
    await db.execute({
        sql: `INSERT INTO notifications (user_id, type, content, link, is_read, created_at) VALUES (?, ?, ?, ?, 0, ?)`,
        args: [userId, type, content, link || null, Date.now()]
    });
}

async function getUserNotifications(userId, limit = 30) {
    const result = await db.execute({
        sql: `SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
        args: [userId, limit]
    });
    return result.rows;
}

async function getUnreadNotificationCount(userId) {
    const result = await db.execute({
        sql: `SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0`,
        args: [userId]
    });
    return result.rows[0].count;
}

async function markNotificationsRead(userId) {
    await db.execute({
        sql: `UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0`,
        args: [userId]
    });
}

// ---------- Web Push ----------
async function savePushSubscription(userId, subscription) {
    await db.execute({
        sql: `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
        args: [userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, Date.now()]
    });
}

async function deletePushSubscriptionByEndpoint(endpoint) {
    await db.execute({ sql: `DELETE FROM push_subscriptions WHERE endpoint = ?`, args: [endpoint] });
}

// Sends a real push notification to every device this user has subscribed
// on. Never throws — a dead/expired subscription just gets cleaned up
// silently, and any failure here must never block the action that
// triggered it (a like/message/join should always succeed regardless).
async function sendPushToUser(userId, { title, body, link }) {
    try {
        const result = await db.execute({ sql: 'SELECT * FROM push_subscriptions WHERE user_id = ?', args: [userId] });
        const payload = JSON.stringify({ title, body, link: link || '/home' });
        for (const row of result.rows) {
            const subscription = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
            try {
                await webpush.sendNotification(subscription, payload);
            } catch (err) {
                if (err.statusCode === 404 || err.statusCode === 410) {
                    // Subscription expired or the browser revoked it — clean it up.
                    await deletePushSubscriptionByEndpoint(row.endpoint);
                } else {
                    console.error('Push send failed (non-fatal):', err.message);
                }
            }
        }
    } catch (err) {
        console.error('sendPushToUser failed (non-fatal):', err);
    }
}

// Fires all three notification channels at once (in-app bell, push, Telegram)
// for a given user, wherever a notify-worthy action happens. `content` should
// be plain, unescaped text — HTML-escaping for Telegram's parse_mode happens
// here internally, so callers don't need to think about it.
function notifyUser(userId, { type, content, link, pushTitle }) {
    createNotification(userId, type, content, link).catch(e => console.error('createNotification failed:', e));
    sendPushToUser(userId, { title: pushTitle || 'BirMillat', body: content, link });
    notifyUserViaTelegram(userId, escapeHtmlForTelegram(content));
}

// ---------- Support chat helpers ----------
async function recordSupportMessage({ telegramChatId, websiteUsername, direction, content, adminMessageId }) {
    const result = await db.execute({
        sql: `INSERT INTO support_messages (telegram_chat_id, website_username, direction, content, admin_message_id, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [telegramChatId, websiteUsername || null, direction, content || null, adminMessageId != null ? String(adminMessageId) : null, Date.now()]
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

// ---------- Articles ("Maqolalar") ----------
async function createArticle(authorId, title, content) {
    const result = await db.execute({
        sql: `INSERT INTO articles (author_id, title, content, created_at) VALUES (?, ?, ?, ?)`,
        args: [authorId, title, content, Date.now()]
    });
    return Number(result.lastInsertRowid);
}

async function listArticles() {
    const result = await db.execute(`
        SELECT articles.*, users.username AS author_username, users.name AS author_name, users.photo_url AS author_photo,
               (SELECT COUNT(*) FROM article_likes WHERE article_likes.article_id = articles.id) AS like_count
        FROM articles JOIN users ON users.id = articles.author_id
        ORDER BY articles.created_at DESC
    `);
    return result.rows;
}

async function getArticleById(id) {
    const result = await db.execute({
        sql: `
            SELECT articles.*, users.username AS author_username, users.name AS author_name, users.photo_url AS author_photo,
                   (SELECT COUNT(*) FROM article_likes WHERE article_likes.article_id = articles.id) AS like_count
            FROM articles JOIN users ON users.id = articles.author_id
            WHERE articles.id = ?
        `,
        args: [id]
    });
    return result.rows[0] || null;
}

async function deleteArticle(id) {
    return db.execute({ sql: 'DELETE FROM articles WHERE id = ?', args: [id] });
}

async function isArticleLiked(articleId, userId) {
    const result = await db.execute({
        sql: 'SELECT 1 FROM article_likes WHERE article_id = ? AND user_id = ?',
        args: [articleId, userId]
    });
    return result.rows.length > 0;
}

async function likeArticle(articleId, userId) {
    return db.execute({
        sql: `INSERT OR IGNORE INTO article_likes (article_id, user_id, created_at) VALUES (?, ?, ?)`,
        args: [articleId, userId, Date.now()]
    });
}

async function unlikeArticle(articleId, userId) {
    return db.execute({
        sql: 'DELETE FROM article_likes WHERE article_id = ? AND user_id = ?',
        args: [articleId, userId]
    });
}

async function createArticleReport(articleId, reporterId, reason) {
    try {
        await db.execute({
            sql: `INSERT INTO article_reports (article_id, reporter_id, reason, created_at) VALUES (?, ?, ?, ?)`,
            args: [articleId, reporterId, reason || null, Date.now()]
        });
        return true;
    } catch (e) {
        return false; // already reported by this user — treated as a harmless no-op, not an error
    }
}

// Deletes the article and issues one warning to its author. At 3 warnings,
// the author is auto-banned via the same setUserBlocked() used by the
// existing Telegram /block command (destroys their active sessions too).
async function deleteArticleAndWarnAuthor(articleId) {
    const article = await getArticleById(articleId);
    if (!article) return { ok: false, reason: 'not_found' };

    await deleteArticle(articleId);

    await db.execute({
        sql: 'UPDATE users SET warning_count = warning_count + 1 WHERE id = ?',
        args: [article.author_id]
    });
    const warningResult = await db.execute({
        sql: 'SELECT warning_count FROM users WHERE id = ?',
        args: [article.author_id]
    });
    const newWarningCount = warningResult.rows[0] ? warningResult.rows[0].warning_count : 0;

    let banned = false;
    if (newWarningCount >= 3) {
        await setUserBlocked(article.author_username, true);
        banned = true;
    }

    return { ok: true, article, newWarningCount, banned };
}

// ---------- Events ----------
async function createEvent({ creatorId, title, description, category, mode, location, eventDate, capacity, socialLink, mapLink, planLink }) {
    const result = await db.execute({
        sql: `INSERT INTO events (creator_id, title, description, category, mode, location, event_date, capacity, social_link, map_link, plan_link, status, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        args: [creatorId, title, description, category, mode, location, eventDate, capacity || null, socialLink || null, mapLink || null, planLink || null, Date.now()]
    });
    return Number(result.lastInsertRowid);
}

async function getEventById(id) {
    const result = await db.execute({
        sql: `SELECT events.*, users.username AS creator_username, users.name AS creator_name, users.photo_url AS creator_photo
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

async function getPastEvents(category, limit) {
    const now = Date.now();
    const sql = category
        ? `SELECT events.*, users.username AS creator_username, users.name AS creator_name,
                  (SELECT COUNT(*) FROM event_attendees WHERE event_attendees.event_id = events.id) AS attendee_count
           FROM events JOIN users ON users.id = events.creator_id
           WHERE events.status = 'approved' AND events.event_date < ? AND events.category = ?
           ORDER BY events.event_date DESC
           LIMIT ?`
        : `SELECT events.*, users.username AS creator_username, users.name AS creator_name,
                  (SELECT COUNT(*) FROM event_attendees WHERE event_attendees.event_id = events.id) AS attendee_count
           FROM events JOIN users ON users.id = events.creator_id
           WHERE events.status = 'approved' AND events.event_date < ?
           ORDER BY events.event_date DESC
           LIMIT ?`;
    const args = category ? [now, category, limit] : [now, limit];
    const result = await db.execute({ sql, args });
    return result.rows;
}

async function setEventRecap(id, { recapImageUrl, recapNote }) {
    return db.execute({
        sql: 'UPDATE events SET recap_image_url = ?, recap_note = ? WHERE id = ?',
        args: [recapImageUrl, recapNote, id]
    });
}

async function setEventStatus(id, status) {
    return db.execute({ sql: 'UPDATE events SET status = ? WHERE id = ?', args: [status, id] });
}

async function deleteEventCascade(id) {
    await db.execute({ sql: 'DELETE FROM event_reviews WHERE event_id = ?', args: [id] });
    await db.execute({ sql: 'DELETE FROM event_team_posts WHERE event_id = ?', args: [id] });
    await db.execute({ sql: 'DELETE FROM event_checkins WHERE event_id = ?', args: [id] });
    await db.execute({ sql: 'DELETE FROM event_coordinators WHERE event_id = ?', args: [id] });
    await db.execute({ sql: 'DELETE FROM event_attendees WHERE event_id = ?', args: [id] });
    await db.execute({ sql: 'DELETE FROM events WHERE id = ?', args: [id] });
}

async function updateEvent(id, { title, description, category, mode, location, eventDate, capacity, socialLink, mapLink, planLink }) {
    return db.execute({
        sql: `UPDATE events SET title = ?, description = ?, category = ?, mode = ?, location = ?,
              event_date = ?, capacity = ?, social_link = ?, map_link = ?, plan_link = ? WHERE id = ?`,
        args: [title, description, category, mode, location, eventDate, capacity || null, socialLink || null, mapLink || null, planLink || null, id]
    });
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
        sql: `SELECT users.id, users.username, users.name, users.photo_url FROM event_attendees
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

// ---------- Event organizing team ----------
async function isEventManager(eventId, userId) {
    const event = await getEventById(eventId);
    if (!event) return false;
    if (event.creator_id === userId) return true;
    const result = await db.execute({
        sql: `SELECT 1 FROM event_coordinators WHERE event_id = ? AND user_id = ?`,
        args: [eventId, userId]
    });
    return result.rows.length > 0;
}

async function getEventCoordinators(eventId) {
    const result = await db.execute({
        sql: `SELECT event_coordinators.id, event_coordinators.role_label, users.username, users.name, users.photo_url
              FROM event_coordinators JOIN users ON users.id = event_coordinators.user_id
              WHERE event_coordinators.event_id = ?
              ORDER BY event_coordinators.created_at ASC`,
        args: [eventId]
    });
    return result.rows;
}

async function addEventCoordinator(eventId, userId, roleLabel, addedBy) {
    return db.execute({
        sql: `INSERT INTO event_coordinators (event_id, user_id, role_label, added_by, created_at) VALUES (?, ?, ?, ?, ?)`,
        args: [eventId, userId, roleLabel, addedBy, Date.now()]
    });
}

async function removeEventCoordinator(coordinatorId, eventId) {
    return db.execute({
        sql: `DELETE FROM event_coordinators WHERE id = ? AND event_id = ?`,
        args: [coordinatorId, eventId]
    });
}

// ---------- Team posts (organizer gallery) ----------
async function getEventTeamPosts(eventId) {
    const result = await db.execute({
        sql: `SELECT event_team_posts.*, users.username, users.name, users.photo_url
              FROM event_team_posts JOIN users ON users.id = event_team_posts.author_id
              WHERE event_team_posts.event_id = ?
              ORDER BY event_team_posts.created_at DESC`,
        args: [eventId]
    });
    return result.rows;
}

async function createEventTeamPost(eventId, authorId, imageUrls, caption) {
    const urls = imageUrls || [];
    const result = await db.execute({
        sql: `INSERT INTO event_team_posts (event_id, author_id, image_url, image_urls, caption, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        args: [eventId, authorId, urls[0] || null, urls.length ? JSON.stringify(urls) : null, caption || null, Date.now()]
    });
    return Number(result.lastInsertRowid);
}

async function deleteEventTeamPost(postId, eventId) {
    return db.execute({ sql: `DELETE FROM event_team_posts WHERE id = ? AND event_id = ?`, args: [postId, eventId] });
}

// ---------- Participant feedback ----------
async function getEventReviews(eventId) {
    const result = await db.execute({
        sql: `SELECT event_reviews.*, users.username, users.name, users.photo_url
              FROM event_reviews JOIN users ON users.id = event_reviews.user_id
              WHERE event_reviews.event_id = ?
              ORDER BY event_reviews.created_at DESC`,
        args: [eventId]
    });
    return result.rows;
}

async function upsertEventReview(eventId, userId, text, imageUrl) {
    return db.execute({
        sql: `INSERT INTO event_reviews (event_id, user_id, text, image_url, created_at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(event_id, user_id) DO UPDATE SET text = excluded.text,
                  image_url = COALESCE(excluded.image_url, event_reviews.image_url)`,
        args: [eventId, userId, text || null, imageUrl || null, Date.now()]
    });
}

// ---------- QR check-in ----------
function generateCheckinToken() {
    return crypto.randomBytes(20).toString('hex');
}

async function createEventCheckin(eventId, userId) {
    const token = generateCheckinToken();
    await db.execute({
        sql: `INSERT INTO event_checkins (event_id, user_id, token, status, created_at) VALUES (?, ?, ?, 'pending', ?)
              ON CONFLICT(event_id, user_id) DO NOTHING`,
        args: [eventId, userId, token, Date.now()]
    });
    return getEventCheckinByUser(eventId, userId);
}

async function getEventCheckinByUser(eventId, userId) {
    const result = await db.execute({
        sql: `SELECT * FROM event_checkins WHERE event_id = ? AND user_id = ?`,
        args: [eventId, userId]
    });
    return result.rows[0] || null;
}

async function getEventCheckinByToken(token) {
    const result = await db.execute({
        sql: `SELECT event_checkins.*, users.username, users.name, users.photo_url,
                     events.title AS event_title, events.event_date, events.creator_id
              FROM event_checkins
              JOIN users ON users.id = event_checkins.user_id
              JOIN events ON events.id = event_checkins.event_id
              WHERE event_checkins.token = ?`,
        args: [token]
    });
    return result.rows[0] || null;
}

async function markCheckinAsUsed(token, checkedInBy) {
    return db.execute({
        sql: `UPDATE event_checkins SET status = 'checked_in', checked_in_at = ?, checked_in_by = ?
              WHERE token = ? AND status = 'pending'`,
        args: [Date.now(), checkedInBy, token]
    });
}

// Verifies a Cloudflare Turnstile response token server-side before a QR pass
// is minted, so the check-in flow can't be spammed into generating throwaway
// passes. Returns true/false; never throws.
async function verifyTurnstile(token, remoteip) {
    const secret = process.env.TURNSTILE_SECRET_KEY;
    if (!secret) {
        // Not configured — fail open in dev, but log loudly so it's obvious
        // in production logs that the captcha step isn't actually protecting anything.
        console.warn('TURNSTILE_SECRET_KEY not set — skipping captcha verification');
        return true;
    }
    if (!token) return false;
    try {
        const params = new URLSearchParams();
        params.append('secret', secret);
        params.append('response', token);
        if (remoteip) params.append('remoteip', remoteip);
        const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            body: params
        });
        const data = await res.json();
        return !!data.success;
    } catch (err) {
        console.error('Turnstile verification error:', err);
        return false;
    }
}

// ---------- Volunteer opportunities ----------
async function getVolunteerOpportunities({ mode, city, search, limit = 50 }) {
    const conditions = [`vo.status = 'active'`];
    const args = [];
    if (mode) { conditions.push('vo.mode = ?'); args.push(mode); }
    if (city) { conditions.push('vo.city = ?'); args.push(city); }
    if (search) { conditions.push('(vo.title LIKE ? OR vo.description LIKE ?)'); args.push(`%${search}%`, `%${search}%`); }
    args.push(limit);
    const result = await db.execute({
        sql: `SELECT vo.*, users.username AS creator_username, users.name AS creator_name, users.photo_url AS creator_photo,
                     (SELECT COUNT(*) FROM volunteer_responses WHERE opportunity_id = vo.id) AS response_count
              FROM volunteer_opportunities vo JOIN users ON users.id = vo.creator_id
              WHERE ${conditions.join(' AND ')}
              ORDER BY vo.created_at DESC
              LIMIT ?`,
        args
    });
    return result.rows;
}

async function getVolunteerOpportunityById(id) {
    const result = await db.execute({
        sql: `SELECT vo.*, users.username AS creator_username, users.name AS creator_name, users.photo_url AS creator_photo
              FROM volunteer_opportunities vo JOIN users ON users.id = vo.creator_id
              WHERE vo.id = ?`,
        args: [id]
    });
    return result.rows[0] || null;
}

async function createVolunteerOpportunity({ creatorId, title, description, mode, city, socialLink }) {
    const result = await db.execute({
        sql: `INSERT INTO volunteer_opportunities (creator_id, title, description, mode, city, social_link, status, created_at)
              VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
        args: [creatorId, title, description, mode, city || null, socialLink || null, Date.now()]
    });
    return Number(result.lastInsertRowid);
}

async function setVolunteerOpportunityStatus(id, status) {
    return db.execute({ sql: `UPDATE volunteer_opportunities SET status = ? WHERE id = ?`, args: [status, id] });
}

async function deleteVolunteerOpportunityCascade(id) {
    await db.execute({ sql: 'DELETE FROM volunteer_responses WHERE opportunity_id = ?', args: [id] });
    await db.execute({ sql: 'DELETE FROM volunteer_opportunities WHERE id = ?', args: [id] });
}

async function getVolunteerResponseCount(opportunityId) {
    const result = await db.execute({
        sql: `SELECT COUNT(*) AS n FROM volunteer_responses WHERE opportunity_id = ?`,
        args: [opportunityId]
    });
    return Number(result.rows[0].n) || 0;
}

async function hasUserResponded(opportunityId, userId) {
    const result = await db.execute({
        sql: `SELECT 1 FROM volunteer_responses WHERE opportunity_id = ? AND user_id = ?`,
        args: [opportunityId, userId]
    });
    return result.rows.length > 0;
}

async function createVolunteerResponse(opportunityId, userId, message) {
    return db.execute({
        sql: `INSERT INTO volunteer_responses (opportunity_id, user_id, message, created_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(opportunity_id, user_id) DO NOTHING`,
        args: [opportunityId, userId, message || null, Date.now()]
    });
}

async function getVolunteerResponses(opportunityId) {
    const result = await db.execute({
        sql: `SELECT volunteer_responses.*, users.username, users.name, users.photo_url
              FROM volunteer_responses JOIN users ON users.id = volunteer_responses.user_id
              WHERE volunteer_responses.opportunity_id = ?
              ORDER BY volunteer_responses.created_at ASC`,
        args: [opportunityId]
    });
    return result.rows;
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

async function getShowcaseCommunities(limit) {
    const result = await db.execute({
        sql: `SELECT c.id, c.name, c.description, c.category, c.image_url,
                     (SELECT COUNT(*) FROM community_members WHERE community_id = c.id) AS member_count
              FROM communities c
              ORDER BY member_count DESC, c.created_at DESC
              LIMIT ?`,
        args: [limit]
    });
    return result.rows;
}

async function getShowcaseProfiles(limit) {
    const result = await db.execute({
        sql: `SELECT name, bio, interests, photo_url, region FROM users
              WHERE showcase_public = 1 AND photo_url IS NOT NULL AND (is_blocked IS NULL OR is_blocked = 0)
              ORDER BY RANDOM()
              LIMIT ?`,
        args: [limit]
    });
    return result.rows;
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


// ---------- Founders ----------
const FOUNDER_ADMIN_USERNAME = (process.env.FOUNDER_ADMIN_USERNAME || '').trim().toLowerCase();

function isFounderAdmin(req) {
    return !!(req.session && req.session.userId && FOUNDER_ADMIN_USERNAME &&
        String(req.session.username || '').toLowerCase() === FOUNDER_ADMIN_USERNAME);
}

function requireFounderAdmin(req, res) {
    if (!req.session || !req.session.userId) {
        res.status(401).json({ error: 'Kirish talab qilinadi' });
        return false;
    }
    if (!FOUNDER_ADMIN_USERNAME) {
        res.status(503).json({ error: 'Founder boshqaruv akkaunti hali sozlanmagan' });
        return false;
    }
    if (!isFounderAdmin(req)) {
        res.status(403).json({ error: 'Bu bo‘lim faqat founder uchun' });
        return false;
    }
    return true;
}

async function getFounders() {
    const result = await db.execute(
        'SELECT id, name, position, description, photo_url, sort_order, instagram_url, telegram_url, linkedin_url FROM founders ORDER BY sort_order ASC, created_at ASC'
    );
    return result.rows;
}

async function getFounderById(id) {
    const result = await db.execute({
        sql: 'SELECT * FROM founders WHERE id = ?',
        args: [id]
    });
    return result.rows[0] || null;
}

async function createFounder({ name, position, description, photoUrl, sortOrder, instagramUrl, telegramUrl, linkedinUrl }) {
    const result = await db.execute({
        sql: 'INSERT INTO founders (name, position, description, photo_url, sort_order, instagram_url, telegram_url, linkedin_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        args: [name, position, description, photoUrl, sortOrder, instagramUrl || null, telegramUrl || null, linkedinUrl || null, Date.now()]
    });
    return Number(result.lastInsertRowid);
}

async function updateFounder(id, { name, position, description, photoUrl, sortOrder, instagramUrl, telegramUrl, linkedinUrl }) {
    if (photoUrl) {
        return db.execute({
            sql: 'UPDATE founders SET name = ?, position = ?, description = ?, photo_url = ?, sort_order = ?, instagram_url = ?, telegram_url = ?, linkedin_url = ? WHERE id = ?',
            args: [name, position, description, photoUrl, sortOrder, instagramUrl || null, telegramUrl || null, linkedinUrl || null, id]
        });
    }
    return db.execute({
        sql: 'UPDATE founders SET name = ?, position = ?, description = ?, sort_order = ?, instagram_url = ?, telegram_url = ?, linkedin_url = ? WHERE id = ?',
        args: [name, position, description, sortOrder, instagramUrl || null, telegramUrl || null, linkedinUrl || null, id]
    });
}

async function deleteFounder(id) {
    return db.execute({ sql: 'DELETE FROM founders WHERE id = ?', args: [id] });
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
        const expires = Date.now() + (sessionData.cookie.maxAge || 30 * 24 * 60 * 60 * 1000);
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
    rolling: true, // refresh the 30-day expiry on every request, so an
                    // active user is never logged out — only someone who
                    // stops visiting for 30 straight days is signed out.
    store: new TursoStore(),
    // 30 days — keeps people logged in across visits ("remember this device")
    // instead of the previous 24h, which was forcing a fresh login every day
    // even though the auto-redirect-if-logged-in logic on GET / was already
    // working correctly the whole time.
    cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production'
    }
});
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname)));

// ---------- Helper: render pages ----------
function renderRegisterPage(message, isError = true) {
    const msgClass = isError ? 'error' : 'success';
    return `<!DOCTYPE html><html><head><script src="/theme.js"></script><title>Ro'yxatdan o'tish - BirMillat</title>
    <link rel="icon" type="image/png" href="/favicon.png">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
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
        .consent-note { font-size: 0.78rem; color: var(--color-text-muted); text-align: left; line-height: 1.5; margin: 0.7rem 0 0; }
        .consent-note a { color: var(--color-accent); font-weight: 600; }
    </style>
    </head>
    <body class="auth-shell">
    <div class="auth-card">
        <img src="/logo-full.svg" alt="BirMillat" class="auth-logo">
        <h2>Hisob yaratish</h2>
        ${message ? `<div class="message ${msgClass}">${message}</div>` : ''}
        <div class="register-form-wrap" id="registerFormWrap">
        <form method=post action=/register id="registerForm">
            <input type="hidden" name="regMethod" id="regMethodInput" value="email">

            <div class="mode-toggle" style="display:flex; gap:0.6rem; margin-bottom:0.8rem;">
                <button type="button" class="mode-btn active" data-method="email" id="methodEmailBtn" style="flex:1; padding:0.65rem; border-radius:var(--radius-sm); border:1.5px solid var(--color-primary); background:#EFEAF8; color:var(--color-primary); font-weight:600; cursor:pointer;">Email</button>
                <button type="button" class="mode-btn" data-method="phone" id="methodPhoneBtn" style="flex:1; padding:0.65rem; border-radius:var(--radius-sm); border:1.5px solid var(--color-border); background:transparent; color:var(--color-text); font-weight:600; cursor:pointer;">Telefon</button>
            </div>

            <input type=email name=email id="emailInput" placeholder="Email manzilingiz" required>
            <input type=tel name=phone id="phoneInput" placeholder="+998 90 123 45 67" style="display:none;">
            <div class="field-hint" id="phoneHint" style="display:none;">Telefon raqamingizni Telegram bot orqali tasdiqlaysiz — SMS yubormaymiz.</div>

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
            <p class="consent-note">Ro'yxatdan o'tish orqali siz bizning <a href="/privacy" target="_blank">Maxfiylik siyosati</a>miz va foydalanish shartlarimizga rozilik bildirasiz.</p>
        </form>
        </div>
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

        // Email/phone method toggle
        const emailBtn = document.getElementById('methodEmailBtn');
        const phoneBtn = document.getElementById('methodPhoneBtn');
        const emailInput = document.getElementById('emailInput');
        const phoneInput = document.getElementById('phoneInput');
        const phoneHint = document.getElementById('phoneHint');
        const regMethodInput = document.getElementById('regMethodInput');

        function setRegMethod(method) {
            regMethodInput.value = method;
            const isPhone = method === 'phone';
            emailBtn.classList.toggle('active', !isPhone);
            phoneBtn.classList.toggle('active', isPhone);
            emailBtn.style.borderColor = isPhone ? 'var(--color-border)' : 'var(--color-primary)';
            emailBtn.style.background = isPhone ? 'transparent' : '#EFEAF8';
            emailBtn.style.color = isPhone ? 'var(--color-text)' : 'var(--color-primary)';
            phoneBtn.style.borderColor = isPhone ? 'var(--color-primary)' : 'var(--color-border)';
            phoneBtn.style.background = isPhone ? '#EFEAF8' : 'transparent';
            phoneBtn.style.color = isPhone ? 'var(--color-primary)' : 'var(--color-text)';

            emailInput.style.display = isPhone ? 'none' : 'block';
            emailInput.required = !isPhone;
            phoneInput.style.display = isPhone ? 'block' : 'none';
            phoneInput.required = isPhone;
            phoneHint.style.display = isPhone ? 'block' : 'none';
        }
        emailBtn.addEventListener('click', () => setRegMethod('email'));
        phoneBtn.addEventListener('click', () => setRegMethod('phone'));
    </script>
    </body></html>`;
}

function renderLoginPage(message, isError = true, next = '/home') {
    const msgClass = isError ? 'error' : 'success';
    const safeNext = safeNextPath(next);
    return `<!DOCTYPE html><html><head><script src="/theme.js"></script><title>Kirish - BirMillat</title>
    <link rel="icon" type="image/png" href="/favicon.png">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
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
          <text x="95" y="53" font-size="34" font-weight="700" fill="#2D1B69" font-family="Sora, -apple-system, sans-serif">Bir<tspan fill="#FF6B5B">Millat</tspan></text>
        </svg>
        <h2>Xush kelibsiz</h2>
        ${message ? `<div class="message ${msgClass}">${message}</div>` : ''}
        <form method=post action=/login>
            <input type=hidden name=next value="${safeNext}">
            <input name=identifier placeholder="Email, telefon yoki foydalanuvchi nomi" required>
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
        let user;
        if (clean.includes('@')) {
            user = await getUserByEmail(clean.toLowerCase());
        } else if (/^\+?\d{9,15}$/.test(normalizePhone(clean))) {
            user = await getUserByPhone(normalizePhone(clean));
        } else {
            user = await getUser(clean);
        }

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

function normalizePhone(raw) {
    // Strip everything except digits and a leading +, so "+998 90 123-45-67"
    // and "998901234567" both normalize to the same stored value.
    const trimmed = (raw || '').trim();
    const digits = trimmed.replace(/[^\d+]/g, '');
    return digits;
}

function isValidPhone(phone) {
    // Loose check: optional leading +, 9-15 digits. Not strict Uzbek-only
    // validation on purpose — people may register from other countries too.
    return /^\+?\d{9,15}$/.test(phone);
}

app.post('/register', async (req, res) => {
    try {
        const { username, email, phone, password, confirmPassword, regMethod } = req.body;
        const cleanUsername = (username || '').trim();
        const method = regMethod === 'phone' ? 'phone' : 'email';

        if (!cleanUsername || !password) {
            return res.send(renderRegisterPage('Barcha maydonlarni to‘ldiring', true));
        }
        if (password.length < 8) {
            return res.send(renderRegisterPage('Parol kamida 8 belgi bo‘lishi kerak', true));
        }
        if (password !== confirmPassword) {
            return res.send(renderRegisterPage('Parollar mos kelmadi', true));
        }

        let cleanIdentifier;
        if (method === 'email') {
            cleanIdentifier = (email || '').trim().toLowerCase();
            if (!cleanIdentifier) {
                return res.send(renderRegisterPage('Email manzilini kiriting', true));
            }
            if (!isValidEmail(cleanIdentifier)) {
                return res.send(renderRegisterPage('Email manzili noto‘g‘ri', true));
            }
        } else {
            cleanIdentifier = normalizePhone(phone);
            if (!cleanIdentifier) {
                return res.send(renderRegisterPage('Telefon raqamingizni kiriting', true));
            }
            if (!isValidPhone(cleanIdentifier)) {
                return res.send(renderRegisterPage('Telefon raqami noto‘g‘ri', true));
            }
        }

        if (await isUsernameTaken(cleanUsername, cleanIdentifier)) {
            return res.send(renderRegisterPage('Bunday foydalanuvchi nomi band', true));
        }

        // Nothing is written to the real `users` table yet. The account is only
        // created once the verification code is confirmed (see POST /verify /
        // the Telegram bot flow below). This is the guarantee: if anything goes
        // wrong here — a typo, a dropped connection, a "Server xatosi" — no row
        // exists under this username/email/phone, so nothing is left stuck or
        // unusable. Only a successful code confirmation ever creates the account.
        const existing = method === 'email' ? await getUserByEmail(cleanIdentifier) : await getUserByPhone(cleanIdentifier);
        if (existing) {
            return res.send(renderRegisterPage(
                method === 'email' ? 'Bu email allaqachon ro‘yxatdan o‘tgan' : 'Bu telefon raqami allaqachon ro‘yxatdan o‘tgan',
                true));
        }

        const hashed = await bcrypt.hash(password, 10);
        await createPendingRegistration(cleanIdentifier, cleanUsername, hashed, method);
        const code = await createVerificationCode(cleanIdentifier, 'register');

        if (method === 'email') {
            try {
                await sendEmail(cleanIdentifier, 'BirMillat — tasdiqlash kodi', verificationEmailHtml(code));
            } catch (emailErr) {
                console.error('Failed to send verification email during registration (pending registration still saved, resend available):', emailErr);
            }
            res.redirect(`/verify?identifier=${encodeURIComponent(cleanIdentifier)}&method=email`);
        } else {
            // No SMS is sent — the code is shown on-screen and the person pastes
            // it into the Telegram bot themselves to prove they control that chat.
            res.redirect(`/verify?identifier=${encodeURIComponent(cleanIdentifier)}&method=phone`);
        }
    } catch (err) {
        console.error('Register error:', err);
        res.send(renderRegisterPage('Server xatosi, qaytadan urinib ko‘ring', true));
    }
});

function renderVerifyPage(identifier, method, message, isError = true, phoneCode = null) {
    const msgClass = isError ? 'error' : 'success';
    const isPhone = method === 'phone';
    return `<!DOCTYPE html><html><head><script src="/theme.js"></script><title>${isPhone ? 'Telefonni tasdiqlash' : 'Emailni tasdiqlash'} - BirMillat</title>
    <link rel="icon" type="image/png" href="/favicon.png">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
    <link rel="stylesheet" href="/style.css">
    <style>
        .auth-logo { height: 40px; margin-bottom: 1rem; }
        .code-input {
            font-size: 1.6rem; letter-spacing: 6px; text-align: center;
            font-weight: 700; color: var(--color-primary);
        }
        .resend-link { font-size: 0.85rem; margin-top: 0.8rem; display: inline-block; }
        .phone-code-display {
            font-family: var(--font-display); font-weight: 700; font-size: 2.2rem;
            letter-spacing: 6px; color: var(--color-primary); background: #EFEAF8;
            border-radius: var(--radius-sm); padding: 1rem; margin: 1rem 0;
        }
        .bot-link-btn {
            display: inline-flex; align-items: center; gap: 0.5rem; width: 100%;
            justify-content: center; background: #29A9EA; color: white; border: none;
            padding: 0.85rem; border-radius: var(--radius-sm); font-weight: 600;
            font-size: 0.95rem; text-decoration: none; margin-top: 0.6rem;
        }
        .waiting-status { font-size: 0.85rem; color: var(--color-text-muted); margin-top: 1rem; display: flex; align-items: center; justify-content: center; gap: 0.5rem; }
    </style>
    </head>
    <body class="auth-shell"><div class="auth-card">
        <img src="/logo-full.svg" alt="BirMillat" class="auth-logo">
        <h2>${isPhone ? 'Telefonni tasdiqlash' : 'Emailni tasdiqlash'}</h2>
        ${isPhone ? `
            <p style="color:var(--color-text-muted); font-size:0.9rem; margin-bottom:0.5rem;">
                Quyidagi kodni <strong>@BirMillat_support_bot</strong> ga Telegram orqali yuboring:
            </p>
            <div class="phone-code-display">${phoneCode || '------'}</div>
            <a href="https://t.me/BirMillat_support_bot?text=${phoneCode || ''}" target="_blank" rel="noopener" class="bot-link-btn">
                <i class="fab fa-telegram"></i> Botni ochish
            </a>
            <div class="waiting-status" id="waitingStatus"><i class="fas fa-circle-notch fa-spin"></i> Tasdiqlanishini kutmoqda...</div>
            ${message ? `<div class="message ${msgClass}" style="margin-top:1rem;">${message}</div>` : ''}
            <form method=post action=/verify/resend style="margin-top:0.6rem;">
                <input type=hidden name=identifier value="${identifier}">
                <input type=hidden name=method value="phone">
                <button type=submit class="resend-link" style="background:none; border:none; color:var(--color-accent); cursor:pointer; width:auto; padding:0;">Yangi kod olish</button>
            </form>
        ` : `
            <p style="color:var(--color-text-muted); font-size:0.9rem; margin-bottom:1rem;">
                <strong>${identifier}</strong> manziliga 6 xonali kod yubordik.
            </p>
            ${message ? `<div class="message ${msgClass}">${message}</div>` : ''}
            <form method=post action=/verify id="verifyForm">
                <input type=hidden name=identifier value="${identifier}">
                <input type=hidden name=method value="email">
                <input name=code class="code-input" placeholder="000000" maxlength=6 inputmode="numeric" required>
                <button type=submit id="verifySubmitBtn">Tasdiqlash</button>
            </form>
            <form method=post action=/verify/resend>
                <input type=hidden name=identifier value="${identifier}">
                <input type=hidden name=method value="email">
                <button type=submit class="resend-link" style="background:none; border:none; color:var(--color-accent); cursor:pointer; width:auto; padding:0;">Kodni qayta yuborish</button>
            </form>
        `}
    </div>
    <script>
        const verifyForm = document.getElementById('verifyForm');
        if (verifyForm) {
            // Prevent double-tap/double-click from submitting the same code twice —
            // a slow connection plus an impatient second tap could otherwise fire
            // two account-creation attempts for the same pending registration.
            verifyForm.addEventListener('submit', function () {
                const btn = document.getElementById('verifySubmitBtn');
                btn.disabled = true;
                btn.textContent = 'Tekshirilmoqda...';
            });
        }

        ${isPhone ? `
        // Poll to detect once the Telegram bot confirms the code — the account
        // gets created server-side the moment that happens, so this just checks
        // whether it's ready yet and redirects to login once it is.
        (function poll() {
            fetch('/api/verify-check?identifier=${encodeURIComponent(identifier)}&method=phone')
                .then(r => r.json())
                .then(data => {
                    if (data.verified) {
                        document.getElementById('waitingStatus').innerHTML = '<i class="fas fa-circle-check" style="color:var(--color-success);"></i> Tasdiqlandi! Yo\\'naltirilmoqda...';
                        setTimeout(() => { window.location.href = '/login'; }, 1200);
                    } else {
                        setTimeout(poll, 3000);
                    }
                })
                .catch(() => setTimeout(poll, 4000));
        })();
        ` : ''}
    </script>
    </body></html>`;
}

app.get('/verify', async (req, res) => {
    const identifier = (req.query.identifier || req.query.email || '').trim();
    const method = req.query.method === 'phone' ? 'phone' : 'email';
    if (!identifier) return res.redirect('/register');

    if (method === 'phone') {
        const pending = await getPendingRegistration(identifier);
        if (!pending) return res.redirect('/register');
        const codeResult = await db.execute({
            sql: `SELECT code FROM verification_codes WHERE email = ? AND purpose = 'register' AND used = 0 ORDER BY created_at DESC LIMIT 1`,
            args: [identifier]
        });
        const code = codeResult.rows[0] ? codeResult.rows[0].code : null;
        return res.send(renderVerifyPage(identifier, 'phone', '', false, code));
    }

    res.send(renderVerifyPage(identifier.toLowerCase(), 'email', ''));
});

app.get('/api/verify-check', async (req, res) => {
    try {
        const identifier = (req.query.identifier || '').trim();
        const method = req.query.method === 'phone' ? 'phone' : 'email';
        if (!identifier) return res.json({ verified: false });
        const user = method === 'phone' ? await getUserByPhone(identifier) : await getUserByEmail(identifier);
        res.json({ verified: !!(user && user.is_verified) });
    } catch (err) {
        console.error('api/verify-check error:', err);
        res.json({ verified: false });
    }
});

app.post('/verify', async (req, res) => {
    try {
        const identifier = (req.body.identifier || req.body.email || '').trim().toLowerCase();
        const code = (req.body.code || '').trim();

        const result = await verifyCode(identifier, code, 'register');
        if (!result.valid) {
            return res.send(renderVerifyPage(identifier, 'email', result.reason, true));
        }

        // Code confirmed — this is the moment the real account gets created.
        const pending = await getPendingRegistration(identifier);
        if (!pending) {
            return res.send(renderVerifyPage(identifier, 'email', 'So‘rov muddati tugagan. Iltimos, qaytadan ro‘yxatdan o‘ting.', true));
        }

        // Re-check uniqueness right before creating — another user could have
        // taken this username/email in the meantime.
        const existingUsername = await getUser(pending.username);
        const existingEmailAcct = await getUserByEmail(identifier);
        if (existingUsername || existingEmailAcct) {
            await deletePendingRegistration(identifier);
            return res.send(renderVerifyPage(identifier, 'email', 'Bu foydalanuvchi nomi yoki email allaqachon band. Qaytadan ro‘yxatdan o‘ting.', true));
        }

        const userId = await createUserSafely(pending.username, identifier, null, pending.password_hash);
        await deletePendingRegistration(identifier);

        req.session.userId = userId;
        req.session.username = pending.username;
        res.redirect('/home');
    } catch (err) {
        console.error('Verify error:', err);
        res.send(renderVerifyPage(req.body.identifier || req.body.email || '', 'email', 'Server xatosi', true));
    }
});

app.post('/verify/resend', async (req, res) => {
    try {
        const identifier = (req.body.identifier || req.body.email || '').trim().toLowerCase();
        const method = req.body.method === 'phone' ? 'phone' : 'email';
        const pending = await getPendingRegistration(identifier);
        if (!pending) {
            return res.send(renderVerifyPage(identifier, method, 'So‘rov muddati tugagan. Iltimos, qaytadan ro‘yxatdan o‘ting.', true));
        }
        const code = await createVerificationCode(identifier, 'register');
        if (method === 'phone') {
            return res.send(renderVerifyPage(identifier, 'phone', 'Yangi kod tayyor', false, code));
        }
        await sendEmail(identifier, 'BirMillat — tasdiqlash kodi', verificationEmailHtml(code));
        res.send(renderVerifyPage(identifier, 'email', 'Yangi kod yuborildi', false));
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

app.get('/privacy', (req, res) => {
    res.sendFile(path.join(__dirname, 'privacy-policy.html'));
});

app.get('/about', (req, res) => {
    res.sendFile(path.join(__dirname, 'about.html'));
});

// llms.txt is an emerging convention (like robots.txt / sitemap.xml, but for
// AI systems) — a plain-text summary of what a site is and does, so an AI
// assistant asked about BirMillat has an authoritative source instead of
// guessing or saying it doesn't know.
app.get('/llms.txt', (req, res) => {
    res.type('text/plain').sendFile(path.join(__dirname, 'llms.txt'));
});

app.get('/robots.txt', (req, res) => {
    res.type('text/plain').sendFile(path.join(__dirname, 'robots.txt'));
});

app.get('/events', (req, res) => {
    res.sendFile(path.join(__dirname, 'events.html'));
});

app.get('/events/create', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'event-create.html'));
});

app.get('/events/:id/edit', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'event-edit.html'));
});

app.get('/events/:id/scan', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'event-scan.html'));
});

app.get('/events/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'event-detail.html'));
});

app.get('/checkin/:token', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'checkin.html'));
});

app.get('/volunteer', (req, res) => {
    res.sendFile(path.join(__dirname, 'volunteer.html'));
});

app.get('/volunteer/create', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'volunteer-create.html'));
});

app.get('/volunteer/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'volunteer-detail.html'));
});

app.get('/communities', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'communities.html'));
});

app.get('/communities/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'community-chat.html'));
});

app.get('/articles', (req, res) => {
    res.sendFile(path.join(__dirname, 'articles.html'));
});

app.get('/articles/create', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'article-create.html'));
});

app.get('/articles/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'article-detail.html'));
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
    return `<!DOCTYPE html><html><head><script src="/theme.js"></script><title>Parolni tiklash - BirMillat</title>
    <link rel="icon" type="image/png" href="/favicon.png">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
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
    return `<!DOCTYPE html><html><head><script src="/theme.js"></script><title>Yangi parol - BirMillat</title>
    <link rel="icon" type="image/png" href="/favicon.png">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
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
        // Successfully entering a code sent to this email already proves
        // ownership of the inbox — no reason to make them verify again
        // separately afterward. This also unsticks any pre-existing account
        // that predates the deferred-verification registration flow.
        await markUserVerified(email);

        res.send(renderLoginPage('Parolingiz yangilandi. Endi kirishingiz mumkin.', false));
    } catch (err) {
        console.error('Reset password error:', err);
        res.send(renderResetPasswordPage(req.body.email || '', 'Server xatosi', true));
    }
});

// API endpoints
// ---------- Public founders page data ----------
// ---------- Volunteer opportunities board ----------
app.get('/api/volunteer', async (req, res) => {
    try {
        const mode = (req.query.mode || '').trim();
        const city = (req.query.city || '').trim();
        const search = (req.query.q || '').trim();
        const opportunities = await getVolunteerOpportunities({
            mode: mode || null, city: city || null, search: search || null
        });
        res.json(opportunities.map(o => ({
            id: o.id, title: o.title, description: o.description, mode: o.mode, city: o.city,
            socialLink: o.social_link, createdAt: o.created_at, responseCount: o.response_count,
            creator: { username: o.creator_username, name: o.creator_name, photoUrl: o.creator_photo }
        })));
    } catch (err) {
        console.error('api/volunteer error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/volunteer/:id', async (req, res) => {
    try {
        const opp = await getVolunteerOpportunityById(req.params.id);
        if (!opp || opp.status !== 'active') return res.status(404).json({ error: 'Topilmadi' });
        const responseCount = await getVolunteerResponseCount(opp.id);
        const hasResponded = req.session.userId ? await hasUserResponded(opp.id, req.session.userId) : false;
        res.json({
            id: opp.id, title: opp.title, description: opp.description, mode: opp.mode, city: opp.city,
            socialLink: opp.social_link, createdAt: opp.created_at, responseCount,
            isCreator: !!req.session.userId && opp.creator_id === req.session.userId, hasResponded,
            creator: { username: opp.creator_username, name: opp.creator_name, photoUrl: opp.creator_photo }
        });
    } catch (err) {
        console.error('api/volunteer/:id error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/volunteer', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const title = (req.body.title || '').trim().slice(0, 150);
        const description = (req.body.description || '').trim().slice(0, 3000);
        const mode = req.body.mode === 'online' ? 'online' : 'offline';
        const city = (req.body.city || '').trim();
        const socialLink = (req.body.socialLink || '').trim();

        if (!title || !description) return res.status(400).json({ error: "Rol nomi va tavsif kerak" });
        if (mode === 'offline' && city && !UZ_REGIONS.includes(city)) {
            return res.status(400).json({ error: "Noto'g'ri viloyat tanlandi" });
        }
        if (socialLink && !/^https?:\/\//i.test(socialLink)) {
            return res.status(400).json({ error: "Havola http:// yoki https:// bilan boshlanishi kerak" });
        }

        const id = await createVolunteerOpportunity({
            creatorId: req.session.userId, title, description, mode,
            city: mode === 'offline' ? city : null, socialLink
        });
        res.status(201).json({ success: true, id });
    } catch (err) {
        console.error('api/volunteer create error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/volunteer/:id/close', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const opp = await getVolunteerOpportunityById(req.params.id);
        if (!opp) return res.status(404).json({ error: 'Topilmadi' });
        if (opp.creator_id !== req.session.userId) return res.status(403).json({ error: "Faqat e'lon muallifi yopa oladi" });
        await setVolunteerOpportunityStatus(opp.id, 'closed');
        res.json({ success: true });
    } catch (err) {
        console.error('api/volunteer/:id/close error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/api/volunteer/:id', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const opp = await getVolunteerOpportunityById(req.params.id);
        if (!opp) return res.status(404).json({ error: 'Topilmadi' });
        if (opp.creator_id !== req.session.userId) return res.status(403).json({ error: "Faqat e'lon muallifi o'chira oladi" });
        await deleteVolunteerOpportunityCascade(opp.id);
        res.json({ success: true });
    } catch (err) {
        console.error('api/volunteer/:id delete error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/volunteer/:id/respond', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const opp = await getVolunteerOpportunityById(req.params.id);
        if (!opp || opp.status !== 'active') return res.status(404).json({ error: 'Topilmadi' });
        if (opp.creator_id === req.session.userId) {
            return res.status(400).json({ error: "O'z e'loningizga qo'l ko'tara olmaysiz" });
        }
        const message = (req.body.message || '').trim().slice(0, 500);
        await createVolunteerResponse(opp.id, req.session.userId, message);

        const responder = await getUserById(req.session.userId);
        notifyUser(opp.creator_id, {
            type: 'volunteer_response',
            content: `✋ @${responder.username} "${opp.title}" e'loningizga qo'l ko'tardi.`,
            link: `/volunteer/${opp.id}`,
            pushTitle: 'Yangi qiziqish bildirildi'
        });

        res.json({ success: true });
    } catch (err) {
        console.error('api/volunteer/:id/respond error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/volunteer/:id/responses', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const opp = await getVolunteerOpportunityById(req.params.id);
        if (!opp) return res.status(404).json({ error: 'Topilmadi' });
        if (opp.creator_id !== req.session.userId) return res.status(403).json({ error: "Ruxsat yo'q" });
        const responses = await getVolunteerResponses(opp.id);
        res.json(responses.map(r => ({
            id: r.id, message: r.message, createdAt: r.created_at,
            user: { username: r.username, name: r.name, photoUrl: r.photo_url }
        })));
    } catch (err) {
        console.error('api/volunteer/:id/responses error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/founders', async (req, res) => {
    try {
        const founders = await getFounders();
        res.json(founders.map(f => ({
            id: f.id, name: f.name, position: f.position, description: f.description,
            photoUrl: f.photo_url, sortOrder: f.sort_order,
            instagramUrl: f.instagram_url, telegramUrl: f.telegram_url, linkedinUrl: f.linkedin_url
        })));
    } catch (err) {
        console.error('api/founders list error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ---------- Public landing-page previews (no login required) ----------
// Both endpoints below are intentionally minimal: communities expose only
// what's already visible on any public listing, and profiles are limited to
// members who explicitly opted in via the "showcase_public" profile setting
// — no username, email, phone, or age is ever included here.
// The Turnstile *site* key is meant to be public (it's embedded in every
// page that shows the widget) — only the *secret* key must stay server-side,
// which it does, in verifyTurnstile(). This just avoids hardcoding the site
// key into every HTML file.
app.get('/api/config/turnstile', (req, res) => {
    res.json({ siteKey: process.env.TURNSTILE_SITE_KEY || null });
});

app.get('/api/public/stats', async (req, res) => {
    try {
        const [userCount, communityCount, eventCount] = await Promise.all([
            db.execute(`SELECT COUNT(*) AS n FROM users`),
            db.execute(`SELECT COUNT(*) AS n FROM communities`),
            db.execute(`SELECT COUNT(*) AS n FROM events WHERE status = 'approved'`)
        ]);
        res.json({
            memberCount: Number(userCount.rows[0].n) || 0,
            communityCount: Number(communityCount.rows[0].n) || 0,
            eventCount: Number(eventCount.rows[0].n) || 0
        });
    } catch (err) {
        console.error('api/public/stats error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/public/communities', async (req, res) => {
    try {
        const communities = await getShowcaseCommunities(6);
        res.json(communities.map(c => ({
            id: c.id,
            name: c.name,
            description: c.description,
            category: c.category,
            imageUrl: c.image_url,
            memberCount: c.member_count
        })));
    } catch (err) {
        console.error('api/public/communities error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/public/profiles', async (req, res) => {
    try {
        const profiles = await getShowcaseProfiles(8);
        res.json(profiles.map(u => ({
            name: u.name,
            bio: u.bio,
            interests: JSON.parse(u.interests || '[]'),
            photoUrl: u.photo_url,
            region: u.region
        })));
    } catch (err) {
        console.error('api/public/profiles error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/founders/manage', (req, res) => {
    res.json({ canManage: isFounderAdmin(req) });
});

function cleanSocialUrl(value) {
    const trimmed = (value || '').trim();
    if (!trimmed) return { ok: true, value: null };
    if (!/^https?:\/\//i.test(trimmed)) return { ok: false };
    return { ok: true, value: trimmed };
}

app.post('/api/founders', upload.single('photo'), async (req, res) => {
    if (!requireFounderAdmin(req, res)) return;
    try {
        const name = (req.body.name || '').trim();
        const position = (req.body.position || '').trim();
        const description = (req.body.description || '').trim();
        const sortOrder = Number.parseInt(req.body.sortOrder, 10) || 0;
        if (!name || !position || !description) return res.status(400).json({ error: 'Ism, lavozim va tavsif kiritilishi kerak' });
        if (!req.file) return res.status(400).json({ error: 'Rasm tanlanmadi' });
        const instagram = cleanSocialUrl(req.body.instagramUrl);
        const telegram = cleanSocialUrl(req.body.telegramUrl);
        const linkedin = cleanSocialUrl(req.body.linkedinUrl);
        if (!instagram.ok || !telegram.ok || !linkedin.ok) {
            return res.status(400).json({ error: 'Ijtimoiy tarmoq havolalari http:// yoki https:// bilan boshlanishi kerak' });
        }
        const uploadResult = await uploadImageToFreeimage(req.file.buffer);
        if (!uploadResult.ok) return res.status(500).json({ error: uploadResult.error });
        const id = await createFounder({
            name, position, description, photoUrl: uploadResult.url, sortOrder,
            instagramUrl: instagram.value, telegramUrl: telegram.value, linkedinUrl: linkedin.value
        });
        res.status(201).json({ success: true, id });
    } catch (err) {
        console.error('api/founders create error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.put('/api/founders/:id', upload.single('photo'), async (req, res) => {
    if (!requireFounderAdmin(req, res)) return;
    try {
        const founder = await getFounderById(req.params.id);
        if (!founder) return res.status(404).json({ error: 'Jamoa a’zosi topilmadi' });
        const name = (req.body.name || '').trim();
        const position = (req.body.position || '').trim();
        const description = (req.body.description || '').trim();
        const sortOrder = Number.parseInt(req.body.sortOrder, 10) || 0;
        if (!name || !position || !description) return res.status(400).json({ error: 'Ism, lavozim va tavsif kiritilishi kerak' });
        const instagram = cleanSocialUrl(req.body.instagramUrl);
        const telegram = cleanSocialUrl(req.body.telegramUrl);
        const linkedin = cleanSocialUrl(req.body.linkedinUrl);
        if (!instagram.ok || !telegram.ok || !linkedin.ok) {
            return res.status(400).json({ error: 'Ijtimoiy tarmoq havolalari http:// yoki https:// bilan boshlanishi kerak' });
        }
        let photoUrl = null;
        if (req.file) {
            const uploadResult = await uploadImageToFreeimage(req.file.buffer);
            if (!uploadResult.ok) return res.status(500).json({ error: uploadResult.error });
            photoUrl = uploadResult.url;
        }
        await updateFounder(req.params.id, {
            name, position, description, photoUrl, sortOrder,
            instagramUrl: instagram.value, telegramUrl: telegram.value, linkedinUrl: linkedin.value
        });
        res.json({ success: true });
    } catch (err) {
        console.error('api/founders update error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/api/founders/:id', async (req, res) => {
    if (!requireFounderAdmin(req, res)) return;
    try {
        const result = await deleteFounder(req.params.id);
        if (result.rowsAffected === 0) return res.status(404).json({ error: 'Jamoa a’zosi topilmadi' });
        res.json({ success: true });
    } catch (err) {
        console.error('api/founders delete error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

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
            region: user.region,
            email: user.email,
            phone: user.phone,
            telegramLinked: !!user.telegram_chat_id,
            showcasePublic: !!user.showcase_public
        });
    } catch (err) {
        console.error('api/me error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'BirMillat_support_bot';

app.post('/api/telegram/link-token', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const token = await createTelegramLinkToken(req.session.userId);
        res.json({ success: true, deepLink: `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${token}` });
    } catch (err) {
        console.error('api/telegram/link-token error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ---------- In-app notification bell ----------
app.get('/api/notifications', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const rows = await getUserNotifications(req.session.userId);
        res.json(rows.map(n => ({
            id: n.id, type: n.type, content: n.content, link: n.link,
            isRead: !!n.is_read, createdAt: n.created_at
        })));
    } catch (err) {
        console.error('api/notifications error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/notifications/unread-count', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const count = await getUnreadNotificationCount(req.session.userId);
        res.json({ count });
    } catch (err) {
        console.error('api/notifications/unread-count error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/notifications/read-all', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        await markNotificationsRead(req.session.userId);
        res.json({ success: true });
    } catch (err) {
        console.error('api/notifications/read-all error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ---------- Web Push subscription management ----------
app.get('/api/push/vapid-public-key', (req, res) => {
    res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const subscription = req.body;
        if (!subscription || !subscription.endpoint || !subscription.keys) {
            return res.status(400).json({ error: 'Invalid subscription' });
        }
        await savePushSubscription(req.session.userId, subscription);
        res.json({ success: true });
    } catch (err) {
        console.error('api/push/subscribe error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/push/unsubscribe', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const { endpoint } = req.body;
        if (endpoint) await deletePushSubscriptionByEndpoint(endpoint);
        res.json({ success: true });
    } catch (err) {
        console.error('api/push/unsubscribe error:', err);
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
        const { name, bio, interests, birthdate, region, showcasePublic } = req.body;

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
        // showcasePublic is only sent by the settings toggle itself; any other
        // profile save (name/bio/etc.) should leave the existing choice as-is.
        const nextShowcasePublic = showcasePublic === undefined ? !!user.showcase_public : !!showcasePublic;
        await updateUserProfile(user.username, { name, bio, interests, birthdate, region, showcasePublic: nextShowcasePublic });
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

const UZ_MONTHS_SERVER = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];
function formatUzDateServer(ts) {
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getDate()} ${UZ_MONTHS_SERVER[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
        // ---------- Account linking: /start <token> from ANY sender ----------
        // Comes from the deep link generated in the profile page. Handled before
        // admin-command routing and before the generic "treat as support message"
        // fallback, so it never accidentally gets forwarded to the admin instead.
        const startMatch = (message.text || '').trim().match(/^\/start\s+(\S+)/);
        if (startMatch) {
            const linkedUser = await linkTelegramByToken(startMatch[1], fromChatId);
            if (linkedUser) {
                await sendTelegramMessageTo(fromChatId,
                    `✅ Telegram hisobingiz @${escapeHtmlForTelegram(linkedUser.username)} bilan ulandi! Endi like, xabar va tadbir bildirishnomalarini shu yerda olasiz.`);
            } else {
                await sendTelegramMessageTo(fromChatId, "❌ Havola muddati tugagan yoki noto'g'ri. Profilingizdan qaytadan urinib ko'ring.");
            }
            return;
        }

        // ---------- Phone registration: bare 6-digit code from ANY sender ----------
        // The person registered with a phone number, saw a code on-screen, and
        // pasted it here to prove they control this Telegram chat — that's the
        // whole "verification" for phone signups, no SMS involved. Also handled
        // before admin/support routing for the same reason as /start above.
        const codeMatch = (message.text || '').trim().match(/^\/?verify\s+(\d{6})$/i) || (message.text || '').trim().match(/^(\d{6})$/);
        if (codeMatch) {
            const code = codeMatch[1];
            const codeRow = await findActiveCodeByCodeOnly(code, 'register');
            if (!codeRow) {
                await sendTelegramMessageTo(fromChatId, "❌ Kod noto'g'ri yoki muddati tugagan. Saytga qaytib, yangi kod oling.");
                return;
            }
            const identifier = codeRow.email; // holds the phone number for phone signups
            const pending = await getPendingRegistration(identifier);
            if (!pending || pending.method !== 'phone') {
                await sendTelegramMessageTo(fromChatId, "❌ Bu kod telefon orqali ro'yxatdan o'tish uchun emas.");
                return;
            }

            const result = await verifyCode(identifier, code, 'register');
            if (!result.valid) {
                await sendTelegramMessageTo(fromChatId, "❌ " + result.reason);
                return;
            }

            const existingUsername = await getUser(pending.username);
            const existingPhone = await getUserByPhone(identifier);
            if (existingUsername || existingPhone) {
                await deletePendingRegistration(identifier);
                await sendTelegramMessageTo(fromChatId, "❌ Bu foydalanuvchi nomi yoki raqam allaqachon band. Saytda qaytadan ro'yxatdan o'ting.");
                return;
            }

            const userId = await createUserSafely(pending.username, null, identifier, pending.password_hash);
            await deletePendingRegistration(identifier);
            // Since we already know their chat here, link Telegram notifications
            // automatically too — no separate linking step needed for phone signups.
            await db.execute({ sql: 'UPDATE users SET telegram_chat_id = ? WHERE id = ?', args: [fromChatId, userId] });

            await sendTelegramMessageTo(fromChatId, `✅ Tasdiqlandi! @${escapeHtmlForTelegram(pending.username)} hisobingiz yaratildi. Endi saytga kirishingiz mumkin.`);
            return;
        }

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
            const deleteArticleMatch = text.match(/^\/delete_article\s+(\d+)/i);

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
            } else if (deleteArticleMatch) {
                const articleId = deleteArticleMatch[1];
                const result = await deleteArticleAndWarnAuthor(articleId);
                if (!result.ok) {
                    await sendTelegramMessage(`❌ Maqola (ID: ${escapeHtmlForTelegram(articleId)}) topilmadi — ehtimol allaqachon o'chirilgan.`);
                } else {
                    let msg = `🗑 Maqola o'chirildi: "${escapeHtmlForTelegram(result.article.title)}"\n` +
                        `⚠️ @${escapeHtmlForTelegram(result.article.author_username)} ga ogohlantirish berildi (${result.newWarningCount}/3).`;
                    if (result.banned) {
                        msg += `\n\n🚫 3-ogohlantirishga yetdi — @${escapeHtmlForTelegram(result.article.author_username)} avtomatik bloklandi.`;
                    }
                    await sendTelegramMessage(msg);
                }
            } else if (text === '/start' || text === '/help') {
                await sendTelegramMessage(
                    `<b>BirMillat admin buyruqlari</b>\n\n` +
                    `/block foydalanuvchi_nomi — hisobni bloklash\n` +
                    `/unblock foydalanuvchi_nomi — blokdan chiqarish\n` +
                    `/delete_article ID — maqolani o'chirish va muallifga ogohlantirish berish (3-ogohlantirish = avtomatik blok)\n\n` +
                    `Foydalanuvchiga javob berish uchun, uning xabariga Telegram'ning "Reply" funksiyasidan foydalaning.`
                );
            }
            return;
        }

        // ---------- Anyone else: treat as an incoming support message ----------
        const fromName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') ||
            message.from?.username || 'Noma\'lum';
        const telegramUsername = message.from?.username ? `@${message.from.username}` : null;

        // If this Telegram chat is linked to a BirMillat account, surface that
        // directly — a clickable link straight to their profile, not just a
        // Telegram display name that tells you nothing about who they are on
        // the actual platform.
        const linkedUser = await getUserByTelegramChatId(fromChatId);
        const identityLine = linkedUser
            ? `Kimdan: ${escapeHtmlForTelegram(fromName)}${telegramUsername ? ' (' + escapeHtmlForTelegram(telegramUsername) + ')' : ''}\n` +
              `Hisob: <a href="${SITE_URL}/u/${encodeURIComponent(linkedUser.username)}">@${escapeHtmlForTelegram(linkedUser.username)}</a>`
            : `Kimdan: ${escapeHtmlForTelegram(fromName)}${telegramUsername ? ' (' + escapeHtmlForTelegram(telegramUsername) + ')' : ''}\n` +
              `Hisob: ulanmagan (faqat Telegram orqali yozmoqda)`;

        let forwarded;
        const captionHeader = `💬 <b>Yordam so'rovi</b>\n${identityLine}`;

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
                websiteUsername: linkedUser ? linkedUser.username : null,
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
            identity = `<a href="${SITE_URL}/u/${encodeURIComponent(username)}">@${escapeHtmlForTelegram(username)}</a> (vebsayt, tizimga kirgan)`;
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

// ---------- Articles ("Maqolalar") ----------
app.get('/api/articles', async (req, res) => {
    try {
        const rows = await listArticles();
        res.json(rows.map(a => ({
            id: a.id,
            title: a.title,
            excerpt: a.content.length > 220 ? a.content.slice(0, 220).trim() + '…' : a.content,
            createdAt: a.created_at,
            likeCount: a.like_count,
            author: { username: a.author_username, name: a.author_name, photoUrl: a.author_photo }
        })));
    } catch (err) {
        console.error('api/articles error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/articles', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const { title, content } = req.body;
        if (!title || !title.trim()) {
            return res.status(400).json({ error: 'Sarlavha kerak' });
        }
        if (!content || !content.trim()) {
            return res.status(400).json({ error: 'Maqola matni kerak' });
        }
        const id = await createArticle(req.session.userId, title.trim(), content.trim());
        res.json({ success: true, id });
    } catch (err) {
        console.error('api/articles create error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/articles/:id', async (req, res) => {
    try {
        const article = await getArticleById(req.params.id);
        if (!article) return res.status(404).json({ error: 'Maqola topilmadi' });
        const isLiked = req.session.userId ? await isArticleLiked(article.id, req.session.userId) : false;
        res.json({
            id: article.id,
            title: article.title,
            content: article.content,
            createdAt: article.created_at,
            likeCount: article.like_count,
            isLiked,
            isAuthor: !!req.session.userId && article.author_id === req.session.userId,
            author: { username: article.author_username, name: article.author_name, photoUrl: article.author_photo }
        });
    } catch (err) {
        console.error('api/articles/:id error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/api/articles/:id', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const article = await getArticleById(req.params.id);
        if (!article) return res.status(404).json({ error: 'Maqola topilmadi' });
        if (article.author_id !== req.session.userId) {
            return res.status(403).json({ error: "Faqat muallif o'z maqolasini o'chirishi mumkin" });
        }
        await deleteArticle(req.params.id);
        res.json({ success: true });
    } catch (err) {
        console.error('api/articles delete error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/articles/:id/like', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const article = await getArticleById(req.params.id);
        if (!article) return res.status(404).json({ error: 'Maqola topilmadi' });

        const alreadyLiked = await isArticleLiked(article.id, req.session.userId);
        if (alreadyLiked) {
            await unlikeArticle(article.id, req.session.userId);
        } else {
            await likeArticle(article.id, req.session.userId);
            if (article.author_id !== req.session.userId) {
                const liker = await getUserById(req.session.userId);
                notifyUser(article.author_id, {
                    type: 'article_like',
                    content: `❤️ @${liker.username} sizning "${article.title}" maqolangizni yoqtirdi.`,
                    link: `/articles/${article.id}`,
                    pushTitle: 'Yangi like'
                });
            }
        }
        const updated = await getArticleById(article.id);
        res.json({ success: true, isLiked: !alreadyLiked, likeCount: updated.like_count });
    } catch (err) {
        console.error('api/articles/:id/like error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/articles/:id/report', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const article = await getArticleById(req.params.id);
        if (!article) return res.status(404).json({ error: 'Maqola topilmadi' });

        const reporter = await getUserById(req.session.userId);
        const { reason } = req.body;
        const wasNew = await createArticleReport(article.id, req.session.userId, (reason || '').trim());

        if (wasNew) {
            const text =
                `🚩 <b>Maqola shikoyati</b>\n\n` +
                `<b>Maqola:</b> ${escapeHtmlForTelegram(article.title)} (ID: ${article.id})\n` +
                `<b>Muallif:</b> @${escapeHtmlForTelegram(article.author_username)}\n` +
                `<b>Shikoyat qildi:</b> @${escapeHtmlForTelegram(reporter.username)}\n` +
                (reason ? `<b>Sabab:</b> ${escapeHtmlForTelegram(reason)}\n` : '') +
                `\nO'chirish va muallifga ogohlantirish berish uchun: <code>/delete_article ${article.id}</code>`;
            await sendTelegramMessage(text);
        }

        res.json({ success: true });
    } catch (err) {
        console.error('api/articles/:id/report error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ---------- Events ----------
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-me-admin-secret';
const SITE_URL = process.env.SITE_URL || 'https://birmillat.uz';

app.get('/api/events', async (req, res) => {
    try {
        const category = (req.query.category || '').trim();
        const events = await getApprovedEvents(category || null);
        res.json(events);
    } catch (err) {
        console.error('api/events error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/events/past', async (req, res) => {
    try {
        const category = (req.query.category || '').trim();
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 24, 1), 50);
        const events = await getPastEvents(category || null, limit);
        const withManagerFlag = await Promise.all(events.map(async ev => ({
            ...ev,
            isCreator: !!req.session.userId && ev.creator_id === req.session.userId,
            isManager: req.session.userId ? await isEventManager(ev.id, req.session.userId) : false
        })));
        res.json(withManagerFlag);
    } catch (err) {
        console.error('api/events/past error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/events/:id/recap', upload.single('photo'), async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const event = await getEventById(req.params.id);
        if (!event) return res.status(404).json({ error: 'Tadbir topilmadi' });
        if (event.creator_id !== req.session.userId) {
            return res.status(403).json({ error: "Faqat tadbir yaratuvchisi hisobot qo'sha oladi" });
        }
        if (event.event_date > Date.now()) {
            return res.status(400).json({ error: "Tadbir hali bo'lib o'tmagan" });
        }
        const recapNote = (req.body.note || '').trim().slice(0, 1000);
        let recapImageUrl = event.recap_image_url || null;
        if (req.file) {
            const uploadResult = await uploadImageToFreeimage(req.file.buffer);
            if (!uploadResult.ok) return res.status(500).json({ error: uploadResult.error });
            recapImageUrl = uploadResult.url;
        }
        if (!recapImageUrl && !recapNote) {
            return res.status(400).json({ error: 'Rasm yoki matn kiriting' });
        }
        await setEventRecap(event.id, { recapImageUrl, recapNote: recapNote || null });
        res.json({ success: true, recapImageUrl, recapNote });
    } catch (err) {
        console.error('api/events/:id/recap error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/events/:id', async (req, res) => {
    try {
        const event = await getEventById(req.params.id);
        if (!event || event.status !== 'approved') {
            return res.status(404).json({ error: 'Tadbir topilmadi' });
        }
        const attendees = await getEventAttendees(event.id);
        const isAttending = req.session.userId ? await isUserAttending(event.id, req.session.userId) : false;
        const coordinators = await getEventCoordinators(event.id);
        const isManager = req.session.userId ? await isEventManager(event.id, req.session.userId) : false;
        const myCheckin = req.session.userId ? await getEventCheckinByUser(event.id, req.session.userId) : null;
        res.json({
            ...event,
            attendees,
            isAttending,
            isCreator: !!req.session.userId && event.creator_id === req.session.userId,
            isManager,
            coordinators: coordinators.map(c => ({
                id: c.id, username: c.username, name: c.name, photoUrl: c.photo_url, roleLabel: c.role_label
            })),
            myCheckin: myCheckin ? { token: myCheckin.token, status: myCheckin.status } : null
        });
    } catch (err) {
        console.error('api/events/:id error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/events', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const { title, description, category, mode, location, eventDate, capacity, socialLink, mapLink, planLink } = req.body;
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
        const cleanSocialLink = (socialLink || '').trim();
        if (cleanSocialLink && !/^https?:\/\//i.test(cleanSocialLink)) {
            return res.status(400).json({ error: "Ijtimoiy tarmoq havolasi http:// yoki https:// bilan boshlanishi kerak" });
        }
        const cleanMapLink = (mapLink || '').trim();
        if (cleanMapLink && !/^https?:\/\//i.test(cleanMapLink)) {
            return res.status(400).json({ error: "Google Maps havolasi http:// yoki https:// bilan boshlanishi kerak" });
        }
        const cleanPlanLink = (planLink || '').trim();
        if (cleanPlanLink && !/^https?:\/\//i.test(cleanPlanLink)) {
            return res.status(400).json({ error: "Reja havolasi http:// yoki https:// bilan boshlanishi kerak" });
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
            capacity: capacity ? parseInt(capacity, 10) : null,
            socialLink: cleanSocialLink || null,
            mapLink: cleanMapLink || null,
            planLink: cleanPlanLink || null
        });

        const approveUrl = `${SITE_URL}/admin/events/${eventId}/approve?token=${ADMIN_SECRET}`;
        const rejectUrl = `${SITE_URL}/admin/events/${eventId}/reject?token=${ADMIN_SECRET}`;
        const dateStr = formatUzDateServer(parsedDate);

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

app.put('/api/events/:id', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const event = await getEventById(req.params.id);
        if (!event) return res.status(404).json({ error: 'Tadbir topilmadi' });
        if (event.creator_id !== req.session.userId) {
            return res.status(403).json({ error: "Faqat tadbir yaratuvchisi uni tahrirlashi mumkin" });
        }

        const { title, description, category, mode, location, eventDate, capacity, socialLink, mapLink, planLink } = req.body;
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
        const cleanSocialLink = (socialLink || '').trim();
        if (cleanSocialLink && !/^https?:\/\//i.test(cleanSocialLink)) {
            return res.status(400).json({ error: "Ijtimoiy tarmoq havolasi http:// yoki https:// bilan boshlanishi kerak" });
        }
        const cleanMapLink = (mapLink || '').trim();
        if (cleanMapLink && !/^https?:\/\//i.test(cleanMapLink)) {
            return res.status(400).json({ error: "Google Maps havolasi http:// yoki https:// bilan boshlanishi kerak" });
        }
        const cleanPlanLink = (planLink || '').trim();
        if (cleanPlanLink && !/^https?:\/\//i.test(cleanPlanLink)) {
            return res.status(400).json({ error: "Reja havolasi http:// yoki https:// bilan boshlanishi kerak" });
        }

        await updateEvent(req.params.id, {
            title: title.trim(),
            description: (description || '').trim(),
            category: category || 'Boshqa',
            mode: mode === 'online' ? 'online' : 'in_person',
            location: (location || '').trim(),
            eventDate: parsedDate,
            capacity: capacity ? parseInt(capacity, 10) : null,
            socialLink: cleanSocialLink || null,
            mapLink: cleanMapLink || null,
            planLink: cleanPlanLink || null
        });

        res.json({ success: true });
    } catch (err) {
        console.error('api/events update error:', err);
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
        if (event.creator_id !== req.session.userId) {
            const joiner = await getUserById(req.session.userId);
            notifyUser(event.creator_id, {
                type: 'event_join',
                content: `🎉 @${joiner.username} "${event.title}" tadbiringizga qo'shildi.`,
                link: `/events/${event.id}`,
                pushTitle: 'Yangi qatnashuvchi'
            });
        }
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

// ---------- RSVP with attendance confirmation + captcha + QR pass ----------
// Flow: person clicks "Qatnashish" -> confirms yes/no to "will you actually be
// there" -> if yes, solves a Turnstile challenge (so the QR-minting step can't
// be spammed) -> we create the attendee record + a one-time check-in token,
// and the frontend renders that token as a QR code.
app.post('/api/events/:id/rsvp', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const event = await getEventById(req.params.id);
        if (!event || event.status !== 'approved') {
            return res.status(404).json({ error: 'Tadbir topilmadi' });
        }
        if (event.event_date < Date.now()) {
            return res.status(400).json({ error: "Bu tadbir allaqachon bo'lib o'tgan" });
        }

        const { willAttend, turnstileToken } = req.body;

        if (!willAttend) {
            await leaveEvent(event.id, req.session.userId);
            return res.json({ success: true, willAttend: false });
        }

        const alreadyAttending = await isUserAttending(event.id, req.session.userId);
        if (!alreadyAttending && event.capacity) {
            const attendees = await getEventAttendees(event.id);
            if (attendees.length >= event.capacity) {
                return res.status(400).json({ error: "Afsuski, joylar tugagan" });
            }
        }

        const captchaOk = await verifyTurnstile(turnstileToken, req.ip);
        if (!captchaOk) {
            return res.status(400).json({ error: "Tekshiruvdan o'ta olmadingiz. Qaytadan urinib ko'ring." });
        }

        await joinEvent(event.id, req.session.userId);
        const checkin = await createEventCheckin(event.id, req.session.userId);

        if (!alreadyAttending && event.creator_id !== req.session.userId) {
            const joiner = await getUserById(req.session.userId);
            notifyUser(event.creator_id, {
                type: 'event_join',
                content: `🎉 @${joiner.username} "${event.title}" tadbiringizga qo'shildi.`,
                link: `/events/${event.id}`,
                pushTitle: 'Yangi qatnashuvchi'
            });
        }

        res.json({ success: true, willAttend: true, token: checkin.token });
    } catch (err) {
        console.error('api/events/:id/rsvp error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ---------- Organizer: cancel or delete their own event ----------
app.post('/api/events/:id/cancel', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const event = await getEventById(req.params.id);
        if (!event) return res.status(404).json({ error: 'Tadbir topilmadi' });
        if (event.creator_id !== req.session.userId) {
            return res.status(403).json({ error: 'Faqat tadbir muallifi bekor qila oladi' });
        }
        await setEventStatus(event.id, 'cancelled');

        const attendees = await getEventAttendees(event.id);
        attendees.forEach(a => {
            if (a.id && a.id !== req.session.userId) {
                notifyUser(a.id, {
                    type: 'event_cancelled',
                    content: `⚠️ "${event.title}" tadbiri tashkilotchi tomonidan bekor qilindi.`,
                    link: `/events`,
                    pushTitle: 'Tadbir bekor qilindi'
                });
            }
        });

        res.json({ success: true });
    } catch (err) {
        console.error('api/events/:id/cancel error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/api/events/:id', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const event = await getEventById(req.params.id);
        if (!event) return res.status(404).json({ error: 'Tadbir topilmadi' });
        if (event.creator_id !== req.session.userId) {
            return res.status(403).json({ error: 'Faqat tadbir muallifi o\'chira oladi' });
        }
        await deleteEventCascade(event.id);
        res.json({ success: true });
    } catch (err) {
        console.error('api/events/:id delete error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ---------- Organizing team (coordinators) ----------
app.get('/api/events/:id/coordinators', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const coordinators = await getEventCoordinators(req.params.id);
        res.json(coordinators.map(c => ({
            id: c.id, username: c.username, name: c.name, photoUrl: c.photo_url, roleLabel: c.role_label
        })));
    } catch (err) {
        console.error('api/events/:id/coordinators error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/events/:id/coordinators', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const event = await getEventById(req.params.id);
        if (!event) return res.status(404).json({ error: 'Tadbir topilmadi' });
        if (event.creator_id !== req.session.userId) {
            return res.status(403).json({ error: 'Faqat tadbir muallifi jamoa a\'zosi qo\'sha oladi' });
        }
        const username = (req.body.username || '').replace(/^@/, '').trim();
        const roleLabel = (req.body.roleLabel || '').trim();
        if (!username || !roleLabel) {
            return res.status(400).json({ error: "Foydalanuvchi nomi va rol kerak" });
        }
        const user = await getUser(username);
        if (!user) return res.status(404).json({ error: "Bunday foydalanuvchi topilmadi" });
        if (user.id === event.creator_id) {
            return res.status(400).json({ error: "Bu foydalanuvchi allaqachon tadbir muallifi" });
        }
        await addEventCoordinator(event.id, user.id, roleLabel, req.session.userId);
        notifyUser(user.id, {
            type: 'event_coordinator',
            content: `✨ Sizni "${event.title}" tadbirida "${roleLabel}" sifatida jamoaga qo'shdilar.`,
            link: `/events/${event.id}`,
            pushTitle: 'Tadbir jamoasi'
        });
        res.json({ success: true });
    } catch (err) {
        if (String(err.message || '').includes('UNIQUE')) {
            return res.status(400).json({ error: 'Bu foydalanuvchi allaqachon jamoada' });
        }
        console.error('api/events/:id/coordinators create error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/api/events/:id/coordinators/:coordId', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const event = await getEventById(req.params.id);
        if (!event) return res.status(404).json({ error: 'Tadbir topilmadi' });
        if (event.creator_id !== req.session.userId) {
            return res.status(403).json({ error: 'Faqat tadbir muallifi jamoadan chiqara oladi' });
        }
        await removeEventCoordinator(req.params.coordId, event.id);
        res.json({ success: true });
    } catch (err) {
        console.error('api/events/:id/coordinators delete error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ---------- Organizing team's gallery (featured content on the past-events tab) ----------
app.get('/api/events/:id/team-posts', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const posts = await getEventTeamPosts(req.params.id);
        res.json(posts.map(p => {
            let imageUrls = [];
            if (p.image_urls) {
                try { imageUrls = JSON.parse(p.image_urls); } catch (e) { imageUrls = []; }
            }
            if (!imageUrls.length && p.image_url) imageUrls = [p.image_url];
            return {
                id: p.id, imageUrls, caption: p.caption, createdAt: p.created_at,
                author: { username: p.username, name: p.name, photoUrl: p.photo_url }
            };
        }));
    } catch (err) {
        console.error('api/events/:id/team-posts error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/events/:id/team-posts', upload.array('photos', 10), async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const event = await getEventById(req.params.id);
        if (!event) return res.status(404).json({ error: 'Tadbir topilmadi' });
        const isManager = await isEventManager(event.id, req.session.userId);
        if (!isManager) return res.status(403).json({ error: "Faqat tashkilotchilar qo'sha oladi" });

        const caption = (req.body.caption || '').trim().slice(0, 1000);
        const files = req.files || [];
        const imageUrls = [];
        for (const file of files) {
            const uploadResult = await uploadImageToFreeimage(file.buffer);
            if (!uploadResult.ok) return res.status(500).json({ error: uploadResult.error });
            imageUrls.push(uploadResult.url);
        }
        if (!imageUrls.length && !caption) return res.status(400).json({ error: 'Rasm yoki matn kiriting' });

        const id = await createEventTeamPost(event.id, req.session.userId, imageUrls, caption);
        res.status(201).json({ success: true, id });
    } catch (err) {
        console.error('api/events/:id/team-posts create error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/api/events/:id/team-posts/:postId', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const event = await getEventById(req.params.id);
        if (!event) return res.status(404).json({ error: 'Tadbir topilmadi' });
        const isManager = await isEventManager(event.id, req.session.userId);
        if (!isManager) return res.status(403).json({ error: "Ruxsat yo'q" });
        await deleteEventTeamPost(req.params.postId, event.id);
        res.json({ success: true });
    } catch (err) {
        console.error('api/events/:id/team-posts delete error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ---------- Participant feedback (lighter-weight, shown secondary to team posts) ----------
app.get('/api/events/:id/reviews', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const reviews = await getEventReviews(req.params.id);
        res.json(reviews.map(r => ({
            id: r.id, text: r.text, imageUrl: r.image_url, createdAt: r.created_at,
            author: { username: r.username, name: r.name, photoUrl: r.photo_url }
        })));
    } catch (err) {
        console.error('api/events/:id/reviews error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/events/:id/reviews', upload.single('photo'), async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const event = await getEventById(req.params.id);
        if (!event) return res.status(404).json({ error: 'Tadbir topilmadi' });
        if (event.event_date > Date.now()) {
            return res.status(400).json({ error: "Tadbir hali bo'lib o'tmagan" });
        }
        const attended = await isUserAttending(event.id, req.session.userId);
        if (!attended) return res.status(403).json({ error: "Faqat qatnashganlar fikr qoldira oladi" });

        const text = (req.body.text || '').trim().slice(0, 1000);
        let imageUrl = null;
        if (req.file) {
            const uploadResult = await uploadImageToFreeimage(req.file.buffer);
            if (!uploadResult.ok) return res.status(500).json({ error: uploadResult.error });
            imageUrl = uploadResult.url;
        }
        if (!text && !imageUrl) return res.status(400).json({ error: 'Fikr yoki rasm kiriting' });

        await upsertEventReview(event.id, req.session.userId, text, imageUrl);
        res.json({ success: true });
    } catch (err) {
        console.error('api/events/:id/reviews create error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ---------- QR check-in: what a scanned pass resolves to ----------
// GET is intentionally low-detail for anyone who isn't the event's organizing
// team — scanning someone else's QR code (or just opening the link) should
// never leak their name to a stranger.
app.get('/api/checkin/:token', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const checkin = await getEventCheckinByToken(req.params.token);
        if (!checkin) return res.status(404).json({ error: 'Chipta topilmadi' });

        const isManager = await isEventManager(checkin.event_id, req.session.userId);
        const isOwner = checkin.user_id === req.session.userId;

        if (!isManager && !isOwner) {
            return res.json({ restricted: true, eventTitle: checkin.event_title });
        }

        res.json({
            restricted: false,
            status: checkin.status,
            eventId: checkin.event_id,
            eventTitle: checkin.event_title,
            eventDate: checkin.event_date,
            attendee: { username: checkin.username, name: checkin.name, photoUrl: checkin.photo_url },
            checkedInAt: checkin.checked_in_at,
            canCheckIn: isManager
        });
    } catch (err) {
        console.error('api/checkin/:token GET error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/checkin/:token', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const checkin = await getEventCheckinByToken(req.params.token);
        if (!checkin) return res.status(404).json({ error: 'Chipta topilmadi' });

        const isManager = await isEventManager(checkin.event_id, req.session.userId);
        if (!isManager) return res.status(403).json({ error: "Faqat tashkilotchilar qabul qila oladi" });

        if (checkin.status === 'checked_in') {
            return res.json({
                success: true,
                alreadyUsed: true,
                attendee: { username: checkin.username, name: checkin.name, photoUrl: checkin.photo_url },
                checkedInAt: checkin.checked_in_at
            });
        }

        await markCheckinAsUsed(req.params.token, req.session.userId);
        res.json({
            success: true,
            alreadyUsed: false,
            attendee: { username: checkin.username, name: checkin.name, photoUrl: checkin.photo_url }
        });
    } catch (err) {
        console.error('api/checkin/:token POST error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Simple one-tap admin approval — no login needed, gated by a secret token
// known only to you (sent in the Telegram notification link).
app.get('/admin/events/:id/approve', async (req, res) => {
    if (req.query.token !== ADMIN_SECRET) return res.status(403).send('Forbidden');
    await setEventStatus(req.params.id, 'approved');
    const event = await getEventById(req.params.id);
    const isPast = event && event.event_date < Date.now();
    const dateStr = event ? formatUzDateServer(event.event_date) : '';
    res.send(
        `✅ Tadbir tasdiqlandi: <b>${event ? escapeHtmlForTelegram(event.title) : ''}</b>\n` +
        `Sana: ${dateStr}\n\n` +
        (isPast
            ? `⚠️ Bu sana allaqachon o'tgan — tadbir "Tashkil qilingan tadbirlar" (o'tgan tadbirlar) bo'limida ko'rinadi, "Kelayotgan tadbirlar"da emas.`
            : `Tadbir "Kelayotgan tadbirlar" bo'limida darhol ko'rinadi.`) +
        `\n\nBu oynani yopishingiz mumkin.`
    );
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
            } else {
                // Not online in the app right now — notify via bell/push/Telegram instead.
                const sender = await getUserById(userId);
                const preview = trimmed.length > 80 ? trimmed.slice(0, 80).trim() + '…' : trimmed;
                notifyUser(receiver.id, {
                    type: 'message',
                    content: `💬 @${sender.username} sizga xabar yubordi: "${preview}"`,
                    link: `/messages?with=${sender.username}`,
                    pushTitle: 'Yangi xabar'
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

// ---------- 404 (must be the last route — catches anything unmatched above) ----------
app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, '404.html'));
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
