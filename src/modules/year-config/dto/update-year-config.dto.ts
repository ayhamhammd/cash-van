import { PartialType, OmitType } from '@nestjs/swagger';
import { CreateYearConfigDto } from './create-year-config.dto';

export class UpdateYearConfigDto extends PartialType(
  OmitType(CreateYearConfigDto, ['year', 'accName'] as const),
) {}
