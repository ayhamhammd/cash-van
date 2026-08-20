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
  @ApiProperty({ enum: ['all', 'assigned'] }) repScopeMode!: 'all' | 'assigned';
  /**
   * Assigned salesmen. Only populated on the single-user endpoint — the list
   * would need one extra query per row to fill it, for a column nobody reads.
   */
  @ApiPropertyOptional({ type: [String] }) repIds?: string[];
  @ApiProperty() canAddCustomer!: boolean;
  @ApiProperty() canCreateCustomerDirect!: boolean;
  @ApiProperty() canPrintLineDiscount!: boolean;
  @ApiProperty() canRequestStock!: boolean;
  @ApiProperty() canApproveStockRequest!: boolean;
  @ApiProperty() canFindCustomers!: boolean;
  @ApiProperty() canEditCustomerCredit!: boolean;
  @ApiProperty() canAddItems!: boolean;
  @ApiProperty() canEditExpiry!: boolean;
  @ApiProperty({ type: [String] }) permissions!: string[];
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
      repScopeMode: u.repScopeMode,
      canAddCustomer: u.canAddCustomer,
      canCreateCustomerDirect: u.canCreateCustomerDirect,
      canPrintLineDiscount: u.canPrintLineDiscount,
      canRequestStock: u.canRequestStock,
      canApproveStockRequest: u.canApproveStockRequest,
      canFindCustomers: u.canFindCustomers,
      canEditCustomerCredit: u.canEditCustomerCredit,
      canAddItems: u.canAddItems,
      canEditExpiry: u.canEditExpiry,
      permissions: u.permissions ?? [],
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
    };
  }
}
