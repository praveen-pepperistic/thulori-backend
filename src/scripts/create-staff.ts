// Usage: npm run seed:staff -- team@thulori.in "Team Thulori" 'a-strong-password' [admin]
import { one } from '../db.js';
import { hashPassword } from '../auth/index.js';
import { closeDb } from '../db.js';

const [email, name, password, role = 'staff'] = process.argv.slice(2);
if (!email || !name || !password || password.length < 12) { console.error('Usage: create-staff <email> <name> <password (12+ chars)> [staff|admin]'); process.exit(1); }
const u = await one(`INSERT INTO users(email, name, password_hash, role) VALUES (lower($1),$2,$3,$4)
                     ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role, password_hash = EXCLUDED.password_hash RETURNING id, email, role`,
  [email, name, await hashPassword(password), role === 'admin' ? 'admin' : 'staff']);
console.log('ok', u);
await closeDb();
