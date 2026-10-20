import pg, { type PoolClient } from 'pg';

export type Transaction = PoolClient;

export class Database {
  readonly pool: pg.Pool;
  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 12, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
  }
  async tx<Result>(tenantId: string, operation: (transaction: Transaction) => Promise<Result>): Promise<Result> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await operation(connection);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }
  async tenants(): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>('SELECT id FROM tenant_directory WHERE active');
    return result.rows.map(row => row.id);
  }
  async close(): Promise<void> { await this.pool.end(); }
}
