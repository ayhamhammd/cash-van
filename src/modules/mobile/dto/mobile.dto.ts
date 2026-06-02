import { ApiProperty } from '@nestjs/swagger';

/**
 * Response DTOs for the mobile BFF. Field names follow the frontend contract
 * (`12-frontend_API`) exactly; these objects appear inside the standard
 * `{ success, data, timestamp }` envelope.
 */

export class SalesmanDto {
  @ApiProperty({ example: 'C001' }) companyNumber!: string;
  @ApiProperty({ example: 'S012' }) salesmanCode!: string;
  @ApiProperty({ example: 'أحمد المصري' }) salesmanNameAr!: string;
  @ApiProperty({ example: 'Ahmad Al-Masri', nullable: true }) salesmanNameEn!: string | null;
  @ApiProperty({ example: '0791234567', nullable: true }) salesmanPhone!: string | null;
  @ApiProperty({ example: 'R-A01', nullable: true }) routeCode!: string | null;
  @ApiProperty({ example: 'مسار وسط عمان', nullable: true }) routeNameAr!: string | null;
  @ApiProperty({ example: 'Central Amman Route', nullable: true }) routeNameEn!: string | null;
  @ApiProperty({ example: '4', nullable: true }) storeNumber!: string | null;
  @ApiProperty({ example: '1', description: 'Default price phase (single-price build → always "1")' })
  pricePhase!: string;
  @ApiProperty({ example: true }) isActive!: boolean;
}

export class CompanyMetaDto {
  @ApiProperty({ example: 'C001' }) companyNumber!: string;
  @ApiProperty({ example: 'S012' }) salesmanCode!: string;
  @ApiProperty({ example: 'كاش فلو للتجارة' }) companyName!: string;
  @ApiProperty({ example: '23423423', nullable: true }) taxNumber!: string | null;
  @ApiProperty({ example: '0793232334', nullable: true }) companyPhone!: string | null;
  @ApiProperty({ example: 'https://cdn.example.com/logo.png', description: 'Logo URL or "" ' })
  logo!: string;
}

export class ItemUnitDto {
  @ApiProperty({ example: 'كرتونة' }) unitName!: string;
  @ApiProperty({ example: '4423524', description: 'Unit barcode' }) unitCode!: string;
  @ApiProperty({ example: '4.200', description: '3-decimal JOD price' }) unitPrice!: string;
  @ApiProperty({ example: '25', description: 'Available stock for this unit in the van' })
  unitQty!: string;
}

export class ItemPriceDto {
  @ApiProperty({ example: '1' }) phaseNumber!: string;
  @ApiProperty({ example: '0.350' }) phasePrice!: string;
}

export class ItemDto {
  @ApiProperty({ example: 'C001' }) companyNumber!: string;
  @ApiProperty({ example: 'S012' }) salesmanCode!: string;
  @ApiProperty({ example: '23232' }) itemCode!: string;
  @ApiProperty({ example: 'مياه معدنية بركة 1.5 لتر' }) itemNameAr!: string;
  @ApiProperty({ example: 'Baraka Mineral Water 1.5L', nullable: true }) itemNameEn!: string | null;
  @ApiProperty({ example: '0.350' }) itemPrice!: string;
  @ApiProperty({ example: '4533455' }) itemBarcode!: string;
  @ApiProperty({ example: 'https://cdn.example.com/items/23232.jpg', description: 'URL or "" ' })
  itemPic!: string;
  @ApiProperty({ example: 'Drinks', nullable: true }) itemCategory!: string | null;
  @ApiProperty({ example: '16' }) taxPerc!: string;
  @ApiProperty({ type: [ItemUnitDto] }) itemUnits!: ItemUnitDto[];
  @ApiProperty({ type: [ItemPriceDto] }) itemPriceList!: ItemPriceDto[];
}

export class ItemBalanceRowDto {
  @ApiProperty({ example: 'C001' }) companyNumber!: string;
  @ApiProperty({ example: 'S012' }) salesmanCode!: string;
  @ApiProperty({ example: '231312' }) itemNumber!: string;
  @ApiProperty({ example: '40' }) itemQty!: string;
  @ApiProperty({ example: '1' }) storeNumber!: string;
}

/** One unit row inside a /mobile/van-stock entry. */
export class VanStockUnitDto {
  @ApiProperty({ format: 'uuid' }) unitId!: string;
  @ApiProperty({ example: 'CTN' }) unitCode!: string;
  @ApiProperty({ example: 'كرتونة' }) unitName!: string;
  @ApiProperty({ example: 'Carton', nullable: true }) unitNameEn!: string | null;
  @ApiProperty({ example: 24, description: 'How many base units make 1 of this unit' })
  qty!: number;
  @ApiProperty({ example: false }) isBase!: boolean;
  @ApiProperty({ example: '4423524' }) barcode!: string;
  @ApiProperty({ example: '8.400' }) salePrice!: string;
}

/** Full item row + on-van quantity + allowed unit mappings (mobile contract). */
export class VanStockItemDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() itemNumber!: string;
  @ApiProperty() name!: string;
  @ApiProperty() barcode!: string;
  @ApiProperty() sku!: string;
  @ApiProperty() nameAr!: string;
  @ApiProperty({ nullable: true }) nameEn!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true }) categoryId!: string | null;
  @ApiProperty() unit!: string;
  @ApiProperty() unitOfMeasure!: string;
  @ApiProperty({ description: 'Base price in fils (1 JOD = 1000 fils)' }) price!: number;
  @ApiProperty({ nullable: true }) cost!: number | null;
  @ApiProperty({ nullable: true }) imageUrl!: string | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() reorderQty!: number;
  @ApiProperty() taxType!: string;
  @ApiProperty() taxCategory!: string;
  @ApiProperty() taxRate!: string;
  @ApiProperty() taxPercentage!: string;
  @ApiProperty({ nullable: true }) photoUrl!: string | null;
  @ApiProperty({ description: 'Current quantity on the van in base units' }) quantity!: number;
  @ApiProperty({ type: [VanStockUnitDto] }) units!: VanStockUnitDto[];
}
