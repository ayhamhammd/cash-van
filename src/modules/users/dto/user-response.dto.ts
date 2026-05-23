import { ApiProperty } from '@nestjs/swagger';
import type { User, UserType } from '../entities/user.entity';

export class UserResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() userNumber!: string;
  @ApiProperty() name!: string;
  @ApiProperty() userType!: UserType;
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
