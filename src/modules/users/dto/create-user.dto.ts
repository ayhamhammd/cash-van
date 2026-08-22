import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsUUID,
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

  @ApiPropertyOptional({
    type: [String],
    description: 'Granular dashboard permission keys (e.g. "vouchers.create").',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  permissions?: string[];

  @ApiPropertyOptional() @IsOptional() @IsBoolean() canMakeVoucher?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() canEditVoucher?: boolean;
  @ApiPropertyOptional({
    enum: ['all', 'assigned'],
    description:
      "'assigned' restricts this user to the salesmen in repIds — reports, approvals, tracking and settlement all filter to them. 'all' (default) sees everyone.",
  })
  @IsOptional() @IsIn(['all', 'assigned']) repScopeMode?: 'all' | 'assigned';

  @ApiPropertyOptional({
    type: [String],
    description:
      'Salesmen this user may see. Only meaningful with repScopeMode=assigned; an empty list means they see nothing.',
  })
  @IsOptional() @IsArray() @IsUUID('4', { each: true }) repIds?: string[];

  @ApiPropertyOptional() @IsOptional() @IsBoolean() canAddCustomer?: boolean;

  @ApiPropertyOptional({
    description:
      'Salesman may create a customer WITHOUT admin approval. Without it, canAddCustomer still lets them submit one for review.',
  })
  @IsOptional() @IsBoolean() canCreateCustomerDirect?: boolean;

  @ApiPropertyOptional({
    description:
      "Show the discount value on each row of this salesman's printed receipt. Off by default — a per-line rate on a slip left at a counter is visible to the next customer.",
  })
  @IsOptional() @IsBoolean() canPrintLineDiscount?: boolean;

  @ApiPropertyOptional({ description: 'May raise a van stock request.' })
  @IsOptional() @IsBoolean() canRequestStock?: boolean;

  @ApiPropertyOptional({ description: "May approve or reject someone else's stock request." })
  @IsOptional() @IsBoolean() canApproveStockRequest?: boolean;

  @ApiPropertyOptional({
    description:
      'Reveals the Find Customers screen on the salesman app. Visibility only — ' +
      'the prospecting API itself is open to any authenticated user.',
  })
  @IsOptional() @IsBoolean() canFindCustomers?: boolean;
  @IsOptional() @IsBoolean() routesOnly?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() canEditCustomerCredit?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() canAddItems?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() canEditExpiry?: boolean;
}
