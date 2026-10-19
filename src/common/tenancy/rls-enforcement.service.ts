import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Boot-time check that tenant isolation is actually in force.
 *
 * A Postgres superuser — or any role with BYPASSRLS — ignores every row-level
 * security policy, FORCE included. The dev container's `POSTGRES_USER` is a
 * superuser and owns all the tables, so connecting as it makes the policies
 * decorative while looking perfectly healthy. That is a silent failure worth
 * a hard stop, because the symptom is one company reading another's data.
 */
@Injectable()
export class RlsEnforcementService implements OnModuleInit {
  private readonly logger = new Logger(RlsEnforcementService.name);

  constructor(
    private readonly config: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async onModuleInit(): Promise<void> {
    const configured = this.config.get<string>('database.appUsername');

    const [row]: { current_user: string; superuser: boolean; bypassrls: boolean }[] =
      await this.dataSource.query(`
        SELECT current_user,
               rolsuper     AS superuser,
               rolbypassrls AS bypassrls
        FROM pg_roles
        WHERE rolname = current_user
      `);

    const bypasses = row?.superuser || row?.bypassrls;

    if (!configured) {
      // Deliberate opt-out: existing single-tenant installs keep working
      // untouched until DB_APP_USERNAME is set. Say so every boot, loudly,
      // so nobody mistakes this for a hardened deployment.
      this.logger.warn(
        `TENANT ISOLATION IS NOT ENFORCED — connected as "${row?.current_user}" ` +
          'with no DB_APP_USERNAME configured. Row-level security policies exist ' +
          'but this role is not subject to them. Set DB_APP_USERNAME / ' +
          'DB_APP_PASSWORD to turn enforcement on.',
      );
      return;
    }

    if (bypasses) {
      throw new Error(
        `DB_APP_USERNAME is set to "${row?.current_user}", but that role can ` +
          'bypass row-level security (SUPERUSER or BYPASSRLS). Every tenant ' +
          'would see every other tenant. Connect as an unprivileged role — the ' +
          'tenancy migration creates one and grants it exactly what it needs.',
      );
    }

    this.logger.log(
      `Tenant isolation enforced — connected as "${row?.current_user}" (no RLS bypass).`,
    );
  }
}
