import { SetMetadata } from '@nestjs/common';

export const ALLOW_INVALID_LICENSE = 'allowInvalidLicense';

/**
 * Let this route run even when the licence is dead.
 *
 * For exactly one kind of endpoint: the one whose job is to DESCRIBE the
 * licence. Refusing that would leave the login screen unable to say why it
 * cannot let anyone in — the customer would get a blank field and no reason,
 * which is how a five-second explanation becomes a support call.
 *
 * Not a general escape hatch. Anything that reads or writes company data must
 * stay behind the refusal.
 */
export const AllowInvalidLicense = () => SetMetadata(ALLOW_INVALID_LICENSE, true);
