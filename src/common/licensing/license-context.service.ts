import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

import { LicenseInfo } from './license.service';

export const LICENSE_KEY = 'license';

/** Per-request holder for the resolved license, alongside the user context. */
@Injectable()
export class LicenseContext {
  constructor(private readonly cls: ClsService) {}

  set(info: LicenseInfo): void {
    this.cls.set(LICENSE_KEY, info);
  }

  get(): LicenseInfo | null {
    return this.cls.get<LicenseInfo | undefined>(LICENSE_KEY) ?? null;
  }

  has(feature: string): boolean {
    return this.get()?.features.includes(feature) ?? false;
  }

  get writesAllowed(): boolean {
    return this.get()?.writesAllowed ?? true;
  }
}
