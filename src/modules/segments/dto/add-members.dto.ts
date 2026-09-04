import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsOptional, IsString, IsUUID } from 'class-validator';

/**
 * Add customers to a static segment. Accepts either customer UUIDs (from the
 * dashboard picker) or customer numbers (from a bulk paste / Excel), or both;
 * they are unioned and de-duplicated against existing membership.
 */
export class AddMembersDto {
  @ApiPropertyOptional({ type: [String], description: 'Customer UUIDs to add' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20000)
  @IsUUID('4', { each: true })
  customerIds?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Customer numbers to add' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20000)
  @IsString({ each: true })
  customerNumbers?: string[];
}
