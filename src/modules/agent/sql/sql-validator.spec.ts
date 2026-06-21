import { InvalidSqlError, SqlValidator } from './sql-validator';

describe('SqlValidator', () => {
  const validator = new SqlValidator();
  const LIMIT = 5000;

  const expectReject = (sql: string) =>
    expect(() => validator.validate(sql, LIMIT)).toThrow(InvalidSqlError);

  describe('accepts read-only SELECTs', () => {
    it('passes a simple select and appends a default LIMIT', () => {
      const out = validator.validate(
        'SELECT customer_name FROM customers',
        LIMIT,
      );
      expect(out.limited).toBe(true);
      expect(out.sql).toContain('LIMIT 5000');
      expect(out.tables).toContain('customers');
    });

    it('keeps an existing LIMIT (does not append)', () => {
      const out = validator.validate(
        'SELECT id FROM customers LIMIT 10',
        LIMIT,
      );
      expect(out.limited).toBe(false);
      expect(out.sql).not.toContain('LIMIT 5000');
    });

    it('allows joins, aggregates and a read-only CTE', () => {
      const sql = `WITH sales AS (
          SELECT voucher_number, net_total::numeric AS amt
          FROM voucher_transactions WHERE trans_kind = 'SALE'
        )
        SELECT h.voucher_number, SUM(s.amt) AS total
        FROM voucher_headers h JOIN sales s ON s.voucher_number = h.voucher_number
        GROUP BY h.voucher_number`;
      expect(() => validator.validate(sql, LIMIT)).not.toThrow();
    });

    it('strips a trailing semicolon', () => {
      const out = validator.validate('SELECT 1;', LIMIT);
      expect(out.sql.trim().endsWith(';')).toBe(false);
    });
  });

  describe('rejects everything else', () => {
    it('rejects empty / whitespace', () => {
      expectReject('');
      expectReject('   ');
    });

    it('rejects INSERT / UPDATE / DELETE', () => {
      expectReject("INSERT INTO customers (id) VALUES ('x')");
      expectReject("UPDATE customers SET name = 'x'");
      expectReject('DELETE FROM customers');
    });

    it('rejects DDL', () => {
      expectReject('DROP TABLE customers');
      expectReject('TRUNCATE customers');
      expectReject('CREATE TABLE x (id int)');
      expectReject('ALTER TABLE customers ADD COLUMN x int');
    });

    it('rejects multiple statements', () => {
      expectReject('SELECT 1; SELECT 2');
      expectReject('SELECT 1; DROP TABLE customers');
    });

    it('rejects data-modifying CTEs', () => {
      expectReject(
        `WITH del AS (DELETE FROM customers RETURNING id) SELECT * FROM del`,
      );
      expectReject(
        `WITH ins AS (INSERT INTO customers (id) VALUES ('x') RETURNING id) SELECT * FROM ins`,
      );
    });

    it('rejects malformed SQL', () => {
      expectReject('SELECT FROM WHERE');
      expectReject('not sql at all');
    });
  });
});
