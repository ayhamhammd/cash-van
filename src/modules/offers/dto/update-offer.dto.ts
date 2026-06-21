import { PartialType } from '@nestjs/swagger';
import { CreateOfferDto } from './create-offer.dto';

/** All create fields optional; `type` may be changed (config is re-validated). */
export class UpdateOfferDto extends PartialType(CreateOfferDto) {}
