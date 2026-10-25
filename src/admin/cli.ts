// Admin console CLI — run inside the MCP container:
//
//   docker compose exec psarelay node dist/admin/cli.js <command>   (older installs: autotask-mcp)
//
//   init [username]                 Create the first administrator (default "admin")
//                                   with a generated password. Refuses once any
//                                   user exists.
//   reset-password <username>       New generated password (must be changed at
//                                   next sign-in); signs the user out everywhere.
//                                   The way back in if every admin is locked out.
//   create-user <username> [admin|viewer]
//                                   Add a user with a generated password (default viewer).
//   enable <username>               Re-enable a disabled user.
//   list-users                      Usernames, roles and last sign-in.
//
// Generated passwords are printed once, to this terminal only — they are not
// logged and cannot be read back later.

import { Logger } from '../utils/logger.js';
import { getPool, closePool } from '../db/pool.js';
import { isPgEnabled } from '../db/config.js';
import { AdminStore, AdminRole } from './store.js';
import { generatePassword, validUsername } from './passwords.js';

const out = (s = ''): void => { process.stdout.write(s + '\n'); };

function banner(username: string, password: string, role: AdminRole, what: string): void {
  out('');
  out('  ┌──────────────────────────────────────────────────────────────┐');
  out(`  │  ${what.padEnd(60)}│`);
  out('  │                                                              │');
  out(`  │  Username : ${username.padEnd(49)}│`);
  out(`  │  Password : ${password.padEnd(49)}│`);
  out(`  │  Role     : ${role.padEnd(49)}│`);
  out('  │                                                              │');
  out('  │  Shown once. You will be asked to change it at first sign-in.│');
  out('  └──────────────────────────────────────────────────────────────┘');
  out('');
}

export async function runCli(argv: string[], store: AdminStore): Promise<number> {
  const [cmd, a, b] = argv;
  switch (cmd) {
    case 'init': {
      const username = a ?? 'admin';
      if (!validUsername(username)) { out(`Invalid username "${username}".`); return 2; }
      const n = await store.countUsers();
      if (n > 0) {
        out(`The admin console already has ${n} user(s) — nothing changed.`);
        out('Lost the password? Run: node dist/admin/cli.js reset-password <username>');
        return 3;
      }
      const password = generatePassword();
      await store.createUser(username, password, 'admin', 'cli', true);
      await store.logEvent('cli', 'user.created', { username, role: 'admin', via: 'init' });
      banner(username, password, 'admin', 'First administrator created');
      return 0;
    }
    case 'reset-password': {
      if (!a) { out('Usage: reset-password <username>'); return 2; }
      const u = await store.findForLogin(a);
      if (!u) { out(`No user "${a}".`); return 4; }
      const password = generatePassword();
      await store.setPassword(u.id, password, true);
      await store.logEvent('cli', 'user.password_reset', { username: u.username });
      banner(u.username, password, u.role, 'Password reset');
      if (u.disabled) out(`Note: "${u.username}" is disabled. Run: node dist/admin/cli.js enable ${u.username}`);
      return 0;
    }
    case 'create-user': {
      const role = (b ?? 'viewer') as AdminRole;
      if (!a || !validUsername(a) || (role !== 'admin' && role !== 'viewer')) { out('Usage: create-user <username> [admin|viewer]'); return 2; }
      if (await store.findForLogin(a)) { out(`User "${a}" already exists.`); return 3; }
      const password = generatePassword();
      await store.createUser(a, password, role, 'cli', true);
      await store.logEvent('cli', 'user.created', { username: a, role });
      banner(a, password, role, 'User created');
      return 0;
    }
    case 'enable': {
      const u = a ? await store.findForLogin(a) : null;
      if (!u) { out(`No user "${a ?? ''}".`); return 4; }
      await store.updateUser(u.id, { disabled: false });
      await store.logEvent('cli', 'user.updated', { username: u.username, disabled: false });
      out(`"${u.username}" is enabled.`);
      return 0;
    }
    case 'list-users': {
      const users = await store.listUsers();
      if (!users.length) { out('No users yet. Run: node dist/admin/cli.js init'); return 0; }
      for (const u of users) out(`${u.username.padEnd(24)} ${u.role.padEnd(7)} ${u.disabled ? 'disabled' : 'active  '} last sign-in: ${u.lastLoginAt ?? 'never'}`);
      return 0;
    }
    default:
      out('Commands: init [username] | reset-password <username> | create-user <username> [admin|viewer] | enable <username> | list-users');
      return cmd ? 2 : 0;
  }
}

async function main(): Promise<void> {
  const logger = new Logger('error');
  if (!isPgEnabled()) { out('The admin console needs the Postgres layer: set MCP_PG_ENABLED=true (see docs/POSTGRES.md).'); process.exit(5); }
  const pool = getPool(logger);
  if (!pool) process.exit(5);
  let code = 1;
  try {
    code = await runCli(process.argv.slice(2), new AdminStore(pool));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    out(/relation "admin_/.test(msg) ? 'The admin tables are missing — run the migrations first: node dist/db/migrate.js' : `Failed: ${msg}`);
  } finally {
    await closePool();
  }
  process.exit(code);
}

if (require.main === module) void main();
