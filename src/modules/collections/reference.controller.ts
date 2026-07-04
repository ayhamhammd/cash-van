import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JORDAN_BANKS } from './banks.constant';

/** Small reference-data endpoints shared by the web + app (any authenticated user). */
@ApiTags('reference')
@ApiBearerAuth()
@Controller({ path: 'reference', version: '1' })
export class ReferenceController {
  @Get('banks')
  @ApiOperation({
    summary: 'List banks',
    description: 'Curated Jordanian banks for the cheque bank dropdown. Any authenticated user.',
  })
  @ApiOkResponse({ description: '{ code, nameAr, nameEn }[]' })
  banks() {
    return JORDAN_BANKS;
  }
}
