import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    max: 20,
    idleTimeoutMillis: 30000,
});

pool.on('connect', () => {
    console.log('✅ PostgreSQL ga ulandi');
});

pool.on('error', (err: Error) => {
    console.error('❌ PostgreSQL xatosi:', err);
});

export default pool;