import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumberString, IsOptional, IsPhoneNumber, IsString, Length } from 'class-validator';

export class CreateVendorDto {
  @ApiPropertyOptional({ description: 'Auto-generated (VEN-000001) when omitted.' })
  @IsOptional()
  @IsString()
  @Length(1, 32)
  vendorNumber?: string;

  @ApiProperty({ example: 'Acme Supplies', description: 'Vendor display name' })
  @IsString()
  @Length(2, 200)
  vendorName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsPhoneNumber(undefined)
  vendorPhone?: string;

  @ApiPropertyOptional({ default: '0' })
  @IsOptional()
  @IsNumberString()
  vendorDebit?: string;

  @ApiPropertyOptional({ default: '0' })
  @IsOptional()
  @IsNumberString()
  vendorCredit?: string;
}
