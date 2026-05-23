import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';
import type { UserType } from '../entities/user.entity';

const USER_TYPES: UserType[] = ['ADMIN', 'MANAGER', 'SALES', 'DRIVER'];

export class CreateUserDto {
  @ApiProperty({ example: 'U-0001' })
  @IsString()
  @Length(1, 32)
  userNumber!: string;

  @ApiProperty({ example: 'Ahmad Sales' })
  @IsString()
  @Length(2, 120)
  name!: string;

  @ApiProperty({ example: 'SuperSecret#1', minLength: 6 })
  @IsString()
  @Length(6, 128)
  password!: string;

  @ApiPropertyOptional({ enum: USER_TYPES, default: 'SALES' })
  @IsOptional()
  @IsIn(USER_TYPES)
  userType?: UserType;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() canMakeVoucher?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() canEditVoucher?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() canAddCustomer?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() canEditCustomerCredit?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() canAddItems?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() canEditExpiry?: boolean;
}
