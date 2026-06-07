import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';
import type { UserRole, UserType } from '../entities/user.entity';

const USER_TYPES: UserType[] = ['ADMIN', 'MANAGER', 'SALES', 'DRIVER'];
const USER_ROLES: UserRole[] = ['admin', 'manager', 'supervisor', 'viewer'];

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

  @ApiPropertyOptional({
    enum: USER_ROLES,
    default: 'viewer',
    description: 'Dashboard RBAC role (drives what the user can do in the dashboard).',
  })
  @IsOptional()
  @IsIn(USER_ROLES)
  role?: UserRole;

  @ApiPropertyOptional({ example: 'أحمد', description: 'Arabic display name' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  nameAr?: string;

  @ApiPropertyOptional({ example: 'Ahmad', description: 'English display name' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  nameEn?: string;

  @ApiPropertyOptional({ example: 'ahmad@example.com' })
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;

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
