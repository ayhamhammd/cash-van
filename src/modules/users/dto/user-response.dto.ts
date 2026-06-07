import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { User, UserRole, UserType } from '../entities/user.entity';

export class UserResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() userNumber!: string;
  @ApiProperty() name!: string;
  @ApiProperty() userType!: UserType;
  @ApiProperty() role!: UserRole;
  @ApiPropertyOptional() nameAr!: string | null;
  @ApiPropertyOptional() nameEn!: string | null;
  @ApiPropertyOptional() email!: string | null;
  @ApiPropertyOptional() lastLoginAt!: Date | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() canMakeVoucher!: boolean;
  @ApiProperty() canEditVoucher!: boolean;
  @ApiProperty() canAddCustomer!: boolean;
  @ApiProperty() canEditCustomerCredit!: boolean;
  @ApiProperty() canAddItems!: boolean;
  @ApiProperty() canEditExpiry!: boolean;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;

  static fromEntity(u: User): UserResponseDto {
    return {
      id: u.id,
      userNumber: u.userNumber,
      name: u.name,
      userType: u.userType,
      role: u.role,
      nameAr: u.nameAr ?? null,
      nameEn: u.nameEn ?? null,
      email: u.email ?? null,
      lastLoginAt: u.lastLoginAt ?? null,
      isActive: u.isActive,
      canMakeVoucher: u.canMakeVoucher,
      canEditVoucher: u.canEditVoucher,
      canAddCustomer: u.canAddCustomer,
      canEditCustomerCredit: u.canEditCustomerCredit,
      canAddItems: u.canAddItems,
      canEditExpiry: u.canEditExpiry,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
    };
  }
}
