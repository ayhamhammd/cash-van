import { PartialType } from '@nestjs/swagger';
import { CreateRepDto } from './create-rep.dto';

export class UpdateRepDto extends PartialType(CreateRepDto) {}
