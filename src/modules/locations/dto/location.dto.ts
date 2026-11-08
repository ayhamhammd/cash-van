import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import { LOCATION_MODES, LocationMode } from '../../settings/entities/app-settings.entity';
import { queryBoolean } from '../../../common/dto/query-boolean';

export class CreateLocationDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'The parent node. Omitted only for the root (the country).',
  })
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @ApiProperty({ example: 'الجبيهة' })
  @IsString()
  @Length(1, 120)
  nameAr!: string;

  @ApiPropertyOptional({ example: 'Jubeiha' })
  @IsOptional()
  @IsString()
  @Length(0, 120)
  nameEn?: string;

  @ApiPropertyOptional({ example: 'JO-AM', description: "A governorate's ISO / JoFotara code; an area's office code." })
  @IsOptional()
  @IsString()
  @Length(0, 16)
  code?: string;

  @ApiPropertyOptional({ example: '#3B82F6' })
  @IsOptional()
  @Matches(/^#[0-9A-Fa-f]{6}$/, { message: 'color must be a hex colour like #3B82F6' })
  color?: string;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateLocationDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Move an area to another governorate. Governorates and the country do not move.',
  })
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 120)
  nameAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 120)
  nameEn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 16)
  code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^#[0-9A-Fa-f]{6}$/, { message: 'color must be a hex colour like #3B82F6' })
  color?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ListLocationsQuery {
  @ApiPropertyOptional({ description: 'Include deactivated nodes (the office page shows them).' })
  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  includeInactive?: boolean;
}

export class ReorderLocationsDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'The parent whose children are reordered; omit for roots.' })
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @ApiProperty({ type: [String], description: 'Every child id, in the new order.' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @IsUUID('all', { each: true })
  ids!: string[];
}

export class LocationMembersDto {
  @ApiProperty({ type: [String], description: 'Customers to place in this area.' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2000)
  @IsUUID('all', { each: true })
  customerIds!: string[];
}

export class ListLocationMembersQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ description: 'Customers of every area under this node, not only its own.' })
  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  subtree?: boolean;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

export class ImportFlatRowDto {
  @ApiProperty({ format: 'uuid', description: 'A customer_areas id.' })
  @IsUUID()
  areaId!: string;

  @ApiProperty({ format: 'uuid', description: 'The governorate the area goes under.' })
  @IsUUID()
  governorateId!: string;
}

export class ImportFlatAreasDto {
  @ApiProperty({ type: [ImportFlatRowDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => ImportFlatRowDto)
  mapping!: ImportFlatRowDto[];
}

export class SwitchLocationModeDto {
  @ApiProperty({ enum: LOCATION_MODES })
  @IsIn(LOCATION_MODES as unknown as string[])
  mode!: LocationMode;

  @ApiPropertyOptional({ description: 'Report what the switch would do, and change nothing.' })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

/** Salesmen who also serve a place's (or one customer's) shops — the whole set. */
export class SetExtraRepsDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description: 'Every salesman who also serves these shops; an empty list removes them all.',
  })
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  repIds!: string[];
}

export class SetLocationRepDto {
  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'The salesman covering this place; null takes it away (its customers fall to the next one up).',
  })
  @IsOptional()
  @IsUUID()
  repId?: string | null;
}

export class DryRunQuery {
  @ApiPropertyOptional({ description: 'Report what would change, and change nothing.' })
  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  dryRun?: boolean;
}
