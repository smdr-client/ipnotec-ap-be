import { drizzle } from 'drizzle-orm/bun-sqlite';
import { Database } from 'bun:sqlite';
import * as schema from './schema';

const sqlite = new Database(process.env.DB_FILE_NAME || './data/portal.db');
sqlite.exec('PRAGMA journal_mode = WAL;');

export const db = drizzle({ client: sqlite, schema });
